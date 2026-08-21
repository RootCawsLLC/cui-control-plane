import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ROOT, loadControls } from './lib/load.mjs';
import { Warehouse } from './warehouse.mjs';
import { selectCollectors } from './collectors/registry.mjs';
import { TABLES, populationTablesFor } from './collectors/tables.mjs';

/**
 * collect -> load -> build -> assert.
 *
 * The whole chain in one command, because the failure mode of a four-command pipeline is somebody
 * running three of them.
 *
 * TWO RULES CARRY THROUGH EVERY STEP AND THEY ARE THE REASON THIS IS TRUSTWORTHY:
 *
 *   1. An incomplete population can never be a pass. If a collector could not establish its
 *      denominator - file missing, permission denied, subscriptions undeclared - the controls over
 *      that table produce NO assertion at all. A zero-row result would read as "nothing failing",
 *      which is the most dangerous sentence a compliance tool can emit.
 *
 *   2. The runner's clock is not an evidence timestamp. `as_of` is chosen once per run and passed
 *      everywhere, so every artifact from one run agrees with itself.
 */

export async function runPipeline({
  config,
  asOf = new Date().toISOString(),
  fixture = false,
  log = console.log,
} = {}) {
  const controls = loadControls();
  const evidenceDir = evidenceDirFor({ config, fixture });
  const { chosen, skipped } = selectCollectors(config);

  // --- collect --------------------------------------------------------------------------------
  const collected = [];
  for (const c of chosen) {
    try {
      const result = await c.collect({ config, collectedAt: asOf, fixture });
      collected.push({ ...result, name: c.name, controls: c.controls });
      const state = result.unavailable
        ? `UNAVAILABLE - ${result.population.reconciliation}`
        : `${result.rows.length} row(s)`;
      log(`  ${c.name.padEnd(28)} ${state}`);

      // A whole estate with no owner tag is almost always the wrong tag KEY, not universal
      // non-compliance. Saying so turns 82 findings back into one configuration line - this was
      // found by pointing the AWS collector at a real account that tags everything, just not with
      // the words this tool assumed.
      const tagged = result.rows.filter((r) => r.owner_tag).length;
      if (result.rows.length >= 5 && tagged === 0 && 'owner_tag' in (result.rows[0] ?? {})) {
        log(
          `  ${''.padEnd(28)} NOTE: 0 of ${result.rows.length} carry the '${config.cloud?.owner_tag ?? 'owner'}' tag. ` +
            'Check cloud.owner_tag matches your tagging convention before treating these as findings.'
        );
      }
    } catch (err) {
      // A collector that throws is a broken run, not an empty population. It is recorded as
      // unavailable so every control over its table is withheld rather than passing vacuously.
      collected.push({
        name: c.name,
        table: c.table,
        rows: [],
        controls: c.controls,
        unavailable: true,
        population: { complete: false, examined: 0, reconciliation: `collector error: ${err.message}` },
      });
      log(`  ${c.name.padEnd(28)} ERROR - ${err.message.split('\n')[0]}`);
    }
  }

  // --- load -----------------------------------------------------------------------------------
  const warehouse = new Warehouse(config.warehouse.path);
  await warehouse.createLandingTables();
  for (const c of collected) {
    if (c.rows.length > 0) await warehouse.load(c.table, c.rows);
  }

  // --- build ----------------------------------------------------------------------------------
  const built = await warehouse.buildModels({ asOf });

  // --- assert ---------------------------------------------------------------------------------
  // A control is only assertable if EVERY table its models read was established completely.
  const unusable = new Map();
  for (const c of collected) {
    if (!c.unavailable && c.population?.complete !== false) continue;
    for (const controlId of TABLES[c.table]?.controls ?? []) {
      unusable.set(controlId, [...(unusable.get(controlId) ?? []), `${c.table}: ${c.population.reconciliation}`]);
    }
  }

  // A table nobody collected is not an empty population, it is an unknown one. Without this, a
  // control whose source has no collector at all asserts 0 of 0 passing - a vacuous pass, and the
  // single most dangerous output this tool could produce.
  // Attempted, not complete. A collector that ran and produced a real population but flagged it
  // insufficient has ALREADY contributed its reason above; saying "no collector populated" on top of
  // that is simply false and sends the analyst looking for a collector that exists.
  const attemptedTables = new Set(collected.filter((c) => !c.unavailable).map((c) => c.table));
  for (const control of controls) {
    const sources = populationTablesFor(control.control_id);
    const present = sources.filter((table) => attemptedTables.has(table));
    if (sources.length > 0 && present.length === 0) {
      unusable.set(control.control_id, [
        ...(unusable.get(control.control_id) ?? []),
        `no collector populated ${sources.join(' or ')} - population unknown, not empty`,
      ]);
    }
  }

  const prior = readPriorEvidence(evidenceDir, { fixture });
  const assertions = [];
  const withheld = [];

  for (const control of controls) {
    const model = control.query_ref.split('/').pop().replace('.sql', '');
    if (unusable.has(control.control_id)) {
      withheld.push({ control_id: control.control_id, reasons: unusable.get(control.control_id) });
      continue;
    }

    const rows = await warehouse.all(`select * from ${model}`);

    // Zero rows from a population table that DID load is legitimate for an event-driven control - a
    // quarter with no incidents is a real answer - but it is a vacuous pass for anything else.
    if (rows.length === 0 && control.cadence !== 'event-driven') {
      withheld.push({
        control_id: control.control_id,
        reasons: [
          `the model returned no rows though ${populationTablesFor(control.control_id).join(', ')} loaded. ` +
            'An empty population is not a passing one; check the source actually contains the members ' +
            'this control is meant to cover.',
        ],
      });
      continue;
    }

    assertions.push(buildAssertion({ control, rows, asOf, fixture, prior, collected }));
  }

  await warehouse.close();

  // A population that fails ENTIRELY, for a single reason, is far more often a missing source or a
  // misconfigured key than an estate that is uniformly broken. Saying so costs one line and stops an
  // analyst opening a ticket per resource on their first day.
  //
  // Returned as well as logged. A caveat that exists only on stdout is invisible to CI, to a
  // scheduled run and to anything consuming this function - which is how a control reported 82 of
  // 82 failing for one reason for as long as it did.
  const notes = [];
  for (const a of assertions) {
    if (a.total < 5 || a.failing_count !== a.total) continue;
    const reasons = new Set(a.failing.map((f) => f.reason));
    if (reasons.size !== 1) continue;
    notes.push(
      `${a.control_id} - all ${a.total} members fail for one reason (${[...reasons][0]}). ` +
        'That is usually a missing source or a misconfigured key rather than uniform non-compliance.'
    );
  }
  notes.push(...reconciliationNotes(collected));
  for (const n of notes) log(`  NOTE: ${n}`);

  // --- write ----------------------------------------------------------------------------------
  mkdirSync(evidenceDir, { recursive: true });
  const targets = assertions.map((a) => ({
    a,
    file: join(evidenceDir, `${a.control_id}@${a.as_of.slice(0, 10)}.json`),
  }));
  // Check EVERY target before writing any. A refusal halfway through would leave the run half
  // written - some controls updated, some not - which is a worse artifact than either outcome
  // the refusal exists to prevent.
  for (const t of targets) refuseToCrossStamps(t.file, t.a);
  for (const t of targets) writeFileSync(t.file, `${JSON.stringify(t.a, null, 2)}\n`);

  return { assertions, withheld, collected, skipped, built, notes, evidenceDir, asOf };
}

/**
 * Turns model rows into the canonical assertion record.
 *
 * first_observed is resolved against PRIOR EVIDENCE, not set to now. That single lookup is what
 * turns a sequence of snapshots into variance episodes with real durations - without it every run
 * would claim each failure was discovered today, and Variance Duration would be permanently zero.
 */
export function buildAssertion({ control, rows, asOf, fixture, prior = {}, collected = [] }) {
  // `passing !== true` rather than `passing === false`. SQL yields NULL for an unknown, and an
  // unknown is not a pass - the never-screened supplier and the untagged asset both arrive here
  // as NULL, and they are exactly the members this pipeline exists to surface.
  const failingRows = rows.filter((r) => r.passing !== true && r.passing !== 1);
  const history = prior[control.control_id] ?? [];

  const failing = failingRows.map((r) => {
    const subjectId = String(r.subject_id);
    return {
      subject_id: subjectId,
      reason: r.reason ?? 'unspecified',
      first_observed: firstObserved(history, subjectId, asOf),
      variance: varianceFor(r, history, subjectId, asOf),
    };
  });

  // EVERY source, not the first one found. The asset inventory reconciles a CMDB, a cloud API and
  // an MDM; picking one of the three meant the confidence tier and the coverage basis described
  // whichever collector happened to sort first, so a hand-exported CSV sitting beside a live API
  // could be reported at the API's tier.
  const sources = collected.filter((c) => (c.controls ?? []).includes(control.control_id));
  const complete = sources.length > 0 && sources.every((c) => c.population?.complete !== false);

  return {
    control_id: control.control_id,
    as_of: asOf,
    population_definition: control.population_definition.trim().replace(/\s+/g, ' '),
    source_system: control.source_system,
    query_ref: control.query_ref,
    total: rows.length,
    passing_count: rows.length - failing.length,
    failing_count: failing.length,
    failing,
    passing: null,
    coverage_basis: coverageBasis({ rows, failing, sources, complete, fixture }),
    confidence_tier: confidenceTier({ sources, fixture }),
    ...(fixture ? { fixture: true } : {}),
  };
}

/**
 * Tier 4 is internal empirical from a system of record. A CSV an analyst exported by hand is real
 * evidence but a point-in-time manual extract, so it does not claim tier 4.
 *
 * Across several sources the answer is the WEAKEST, not the best available. A reconciliation is
 * only as good as its shakiest input: an asset inventory built from a live cloud API and a
 * spreadsheet is a spreadsheet-grade claim, and reporting it at the API's tier overstates it.
 */
export function confidenceTier({ sources, fixture }) {
  if (fixture) return 2;
  if (sources.length === 0) return 3;
  const tierOf = (c) =>
    c.population?.source_of_truth?.startsWith('/') || c.name?.startsWith('csv') ? 3 : 4;
  return Math.min(...sources.map(tierOf));
}

function coverageBasis({ rows, failing, sources, complete, fixture }) {
  const parts = [`${rows.length} member(s) in the population, ${failing.length} failing.`];
  // Named individually. "Source of truth: <one file>" on a three-way reconciliation reads as
  // though one file were the whole basis, which is the overstatement this record must not make.
  for (const c of sources) {
    if (c.population?.source_of_truth) parts.push(`Source of truth (${c.name}): ${c.population.source_of_truth}.`);
    if (c.population?.reconciliation) parts.push(`Reconciliation (${c.name}): ${c.population.reconciliation}.`);
  }
  if (!complete) parts.push('POPULATION INCOMPLETE - this assertion cannot support a pass.');
  if (fixture) parts.push('NOT REAL EVIDENCE - generated from bundled fixtures.');
  return parts.join(' ');
}

/** Earliest as_of of the current unbroken run of failures for this subject. */
export function firstObserved(history, subjectId, asOf) {
  let earliest = asOf;
  // History is oldest-first; walk backwards and stop at the first snapshot where it was passing.
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const snap = history[i];
    const wasFailing = snap.failing.some((f) => f.subject_id === subjectId);
    if (!wasFailing) break;
    earliest = snap.as_of;
  }
  return earliest;
}

function varianceFor(row, history, subjectId, asOf) {
  const detected = firstObserved(history, subjectId, asOf);

  // Where a model surfaces the source system's own change timestamp, that is option (a) - the only
  // basis that does not understate duration. Otherwise the honest answer is equals_detected, and
  // saying so is what keeps every derived reliability figure an upper bound rather than a claim.
  const started = row.variance_started_at_candidate ?? row.variance_started_at ?? null;

  return {
    variance_started_at: started ? new Date(started).toISOString() : null,
    variance_detected_at: detected,
    remediation_started_at: row.remediation_started_at ? new Date(row.remediation_started_at).toISOString() : null,
    remediation_completed_at: row.remediation_completed_at ? new Date(row.remediation_completed_at).toISOString() : null,
    started_at_basis: started ? (row.started_at_basis ?? 'source_system') : 'equals_detected',
  };
}

/**
 * Below this, two sources that are supposed to describe one estate are treated as describing two.
 *
 * Expressed against the SMALLER source, not the union: a CMDB tracking 68 things inside an account
 * that reports 82 should recognise most of its own 68. Using the union would let a large, mostly
 * irrelevant cloud population mask a CMDB that matches nothing.
 *
 * Five per cent is a convention rather than a measurement, and deliberately near-zero. Real
 * estates overlap only partially - a cloud account is full of IAM roles and provider-managed
 * resources no CMDB tracks - so a high threshold would fire constantly and be switched off. The
 * signal worth having is "these two have essentially nothing in common", which is not a compliance
 * finding at all.
 */
export const MIN_RECONCILIATION_OVERLAP = 0.05;

/**
 * Below this many members on either side, overlap says nothing and is not reported.
 *
 * Three rows sharing none of their identifiers is a coincidence; sixty-eight sharing one is a
 * different file. Without a floor the guard would fire on every small fixture and teach people to
 * ignore it.
 */
export const MIN_RECONCILIATION_MEMBERS = 10;

/**
 * Flags reconciling sources that turn out not to describe the same estate.
 *
 * THIS EXISTS BECAUSE THE CONTROL COULD NOT TELL THE TWO APART. Against lab account 445817184167,
 * the asset inventory reported 81 unmanaged assets and 68 unclassified ones - which reads as an
 * estate in serious disarray. In fact the CMDB export and the cloud query shared exactly ONE
 * identifier out of 68, because AWS Config had no recorder and was answering from a decommissioned
 * index while the CMDB described resources that genuinely existed. Both sides were well formed,
 * both used identical identifier formats, and normalising the join key recovered nothing. The
 * numbers were not findings about the estate; they were the two inputs not being about each other.
 *
 * A note rather than a withholding: the population is established, and the members really are in
 * it. What is not established is that comparing them means anything, and that belongs in front of
 * whoever reads the result.
 */
export function reconciliationNotes(collected) {
  const out = [];
  const usable = collected.filter((c) => !c.unavailable && c.population?.complete !== false);
  const byTable = new Map(usable.map((c) => [c.table, c]));
  const seen = new Set();

  for (const c of usable) {
    for (const other of TABLES[c.table]?.reconciles_with ?? []) {
      const pairKey = [c.table, other].sort().join('|');
      if (seen.has(pairKey)) continue;
      const partner = byTable.get(other);
      if (!partner) continue; // One side absent is a different problem, already reported as such.
      seen.add(pairKey);

      const keyA = TABLES[c.table]?.subject_key;
      const keyB = TABLES[other]?.subject_key;
      if (!keyA || !keyB) continue;

      const a = new Set(c.rows.map((r) => r[keyA]).filter(Boolean));
      const b = new Set(partner.rows.map((r) => r[keyB]).filter(Boolean));
      if (a.size < MIN_RECONCILIATION_MEMBERS || b.size < MIN_RECONCILIATION_MEMBERS) continue;

      let shared = 0;
      for (const x of a) if (b.has(x)) shared += 1;
      const ratio = shared / Math.min(a.size, b.size);
      if (ratio >= MIN_RECONCILIATION_OVERLAP) continue;

      out.push(
        `${c.name} and ${partner.name} are supposed to be independent views of the same estate, but ` +
          `share ${shared} of ${Math.min(a.size, b.size)} identifiers ` +
          `(${c.table}: ${a.size}, ${other}: ${b.size}). They are almost certainly not describing the ` +
          'same thing - a stale or wrong export, the wrong account or region, or a source that is ' +
          'not actually reporting. Findings from this reconciliation are not trustworthy until that ' +
          'is resolved.'
      );
    }
  }
  return out;
}

/**
 * Where this run writes. SYNTHETIC AND REAL EVIDENCE NEVER SHARE A DIRECTORY.
 *
 * A fixture run used to write `<control>@<date>.json` into the same directory as a live run, so
 * a demo silently destroyed that day's real evidence - and `.evidence/` is gitignored, so there
 * was nothing to restore from.
 *
 * The fixture directory is DERIVED rather than configured, so existing deployments separate
 * correctly without anybody editing a config file. It nests under the real path deliberately:
 * readdirSync does not recurse, so a real run cannot see fixture snapshots even by accident.
 */
export function evidenceDirFor({ config, fixture = false } = {}) {
  // resolve, not join: an absolute evidence path is legitimate configuration, and join would
  // glue it onto the repo root and produce a nonsense directory.
  const real = resolve(ROOT, config?.evidence?.path ?? '.evidence');
  if (!fixture) return real;
  return config?.evidence?.fixture_path
    ? resolve(ROOT, config.evidence.fixture_path)
    : join(real, 'fixture');
}

/**
 * Refuses to overwrite an assertion with one of the opposite kind.
 *
 * Separate directories already prevent this; this is the second lock, for the case where someone
 * points `evidence.fixture_path` at the real directory or drops a demo artifact into it by hand.
 * Losing real evidence has to be an error somebody sees, never a silent overwrite.
 */
export function refuseToCrossStamps(file, assertion) {
  if (!existsSync(file)) return;
  let existing;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return; // Unreadable: not evidence anybody can lose. The run replaces it.
  }
  const was = existing.fixture === true;
  const now = assertion.fixture === true;
  if (was === now) return;
  throw new Error(
    `refusing to overwrite ${was ? 'FIXTURE' : 'REAL'} evidence with a ${now ? 'FIXTURE' : 'REAL'} run: ${file}
` +
      'Synthetic and real evidence must not share a directory. Check evidence.path and ' +
      'evidence.fixture_path in ccp.config.yaml, then move or delete the file deliberately.'
  );
}

/**
 * Prior snapshots for this run, of THIS RUN'S KIND only.
 *
 * The stamp filter is defence in depth - the directories are already separate - but a legacy
 * directory from before that split still holds both kinds, and a real assertion must never date
 * a finding from a synthetic one. Without this, a genuine finding inherited first_observed from
 * a made-up snapshot and was emitted unstamped at confidence tier 4, with the fabricated
 * duration flowing into Variance Duration and out to the risk layer.
 */
export function readPriorEvidence(dir, { fixture = false } = {}) {
  if (!existsSync(dir)) return {};
  const byControl = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if ((a.fixture === true) !== fixture) continue;
      byControl[a.control_id] = [...(byControl[a.control_id] ?? []), a];
    } catch {
      // A corrupt evidence file must not take the run down; it is skipped and the population
      // simply lacks that snapshot of history.
    }
  }
  for (const k of Object.keys(byControl)) byControl[k].sort((a, b) => a.as_of.localeCompare(b.as_of));
  return byControl;
}

export function formatPipeline(result) {
  const out = [];
  const kind = result.assertions.some((x) => x.fixture) ? 'FIXTURE evidence' : 'Evidence';
  out.push(`${kind} written to ${result.evidenceDir} (as of ${result.asOf})`);
  out.push('');
  out.push(`  ${result.assertions.length} control(s) asserted:`);
  for (const a of result.assertions) {
    out.push(`    ${a.control_id.padEnd(52)} ${a.passing_count}/${a.total} passing`);
  }

  if (result.withheld.length > 0) {
    out.push('');
    out.push(`  ${result.withheld.length} control(s) WITHHELD - the population could not be established,`);
    out.push('  and an unestablished population is never a pass:');
    for (const w of result.withheld) {
      out.push(`    ${w.control_id}`);
      for (const r of w.reasons) out.push(`      ${r}`);
    }
  }

  if (result.skipped.length > 0) {
    out.push('');
    out.push('  Not configured:');
    for (const s of result.skipped) out.push(`    ${s.name.padEnd(28)} ${s.reason}`);
  }
  return out.join('\n');
}
