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
  // resolve, not join: an absolute evidence path is legitimate configuration, and join would
  // glue it onto the repo root and produce a nonsense directory.
  const evidenceDir = resolve(ROOT, config.evidence?.path ?? '.evidence');
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
  const collectedTables = new Set(
    collected.filter((c) => !c.unavailable && c.population?.complete !== false).map((c) => c.table)
  );
  for (const control of controls) {
    const sources = populationTablesFor(control.control_id);
    const present = sources.filter((table) => collectedTables.has(table));
    if (sources.length > 0 && present.length === 0) {
      unusable.set(control.control_id, [
        ...(unusable.get(control.control_id) ?? []),
        `no collector populated ${sources.join(' or ')} - population unknown, not empty`,
      ]);
    }
  }

  const prior = readPriorEvidence(evidenceDir);
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
  for (const a of assertions) {
    if (a.total < 5 || a.failing_count !== a.total) continue;
    const reasons = new Set(a.failing.map((f) => f.reason));
    if (reasons.size !== 1) continue;
    log(
      `  NOTE: ${a.control_id} - all ${a.total} members fail for one reason (${[...reasons][0]}). ` +
        'That is usually a missing source or a misconfigured key rather than uniform non-compliance.'
    );
  }

  // --- write ----------------------------------------------------------------------------------
  mkdirSync(evidenceDir, { recursive: true });
  for (const a of assertions) {
    writeFileSync(
      join(evidenceDir, `${a.control_id}@${a.as_of.slice(0, 10)}.json`),
      `${JSON.stringify(a, null, 2)}\n`
    );
  }

  return { assertions, withheld, collected, skipped, built, evidenceDir, asOf };
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

  const source = collected.find((c) => (c.controls ?? []).includes(control.control_id));
  const complete = source?.population?.complete !== false;

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
    coverage_basis: coverageBasis({ rows, failing, source, complete, fixture }),
    // Tier 4 is internal empirical from a system of record. A CSV an analyst exported by hand is
    // real evidence but it is a point-in-time manual extract, so it does not claim tier 4.
    confidence_tier: fixture ? 2 : source?.population?.source_of_truth?.startsWith('/') || source?.name?.startsWith('csv') ? 3 : 4,
    ...(fixture ? { fixture: true } : {}),
  };
}

function coverageBasis({ rows, failing, source, complete, fixture }) {
  const parts = [`${rows.length} member(s) in the population, ${failing.length} failing.`];
  if (source?.population?.source_of_truth) parts.push(`Source of truth: ${source.population.source_of_truth}.`);
  if (source?.population?.reconciliation) parts.push(`Reconciliation: ${source.population.reconciliation}.`);
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

export function readPriorEvidence(dir) {
  if (!existsSync(dir)) return {};
  const byControl = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
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
  out.push(`Evidence written to ${result.evidenceDir} (as of ${result.asOf})`);
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
