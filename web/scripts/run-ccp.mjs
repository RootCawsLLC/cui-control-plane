/**
 * Standalone cui-control-plane driver.
 *
 * Runs in its own plain Node ESM process — the same way `src/cli.mjs` runs the
 * tool — so cui-control-plane is never touched by the Next bundler and its
 * filesystem behavior is exactly as shipped. The API route spawns this, writes a
 * request as JSON on stdin, and reads a result as JSON on stdout.
 *
 * It imports the REAL tool modules natively (never a reimplementation) and calls
 * the exact functions `ccp coverage`, `ccp sprs`, `ccp variance` and `ccp emit all`
 * call. The OSCAL emit sequence mirrors src/cli.mjs line for line.
 *
 * Target policy: this only ever reads the bundled synthetic fixtures. It imports
 * no collector and never runs the pipeline, so nothing contacts a real system and
 * no credential is ever used. The assertion set is asserted to be fixture data
 * before anything is emitted.
 */
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// The tool's own modules. No "exports" field in its package.json, so these
// subpaths resolve to the real source files, and each module's ROOT constant
// resolves to the tool repo root (which carries controls/, reference/, fixtures/).
const { loadControls, loadAssertions, latestPerControl, isFixtureSet, FIXTURE_STAMP } =
  await import('cui-control-plane/src/lib/load.mjs');
const { coverage } = await import('cui-control-plane/src/coverage.mjs');
const { score, UnverifiedWeights } = await import('cui-control-plane/src/sprs.mjs');
const { variance } = await import('cui-control-plane/src/variance.mjs');
const { serialize } = await import('cui-control-plane/src/oscal/common.mjs');
const { catalog, profiles } = await import('cui-control-plane/src/oscal/catalog.mjs');
const { componentDefinition } = await import('cui-control-plane/src/oscal/component-definition.mjs');
const { assessmentPlan } = await import('cui-control-plane/src/oscal/assessment-plan.mjs');
const { assessmentResults } = await import('cui-control-plane/src/oscal/assessment-results.mjs');
const { poam } = await import('cui-control-plane/src/oscal/poam.mjs');
const { ssp } = await import('cui-control-plane/src/oscal/ssp.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

// Bundled-into-web fixtures travel with the container. Overridable, but the
// default keeps the demo self-contained regardless of the tool's own layout.
function assertionsDir() {
  return process.env.CCP_ASSERTIONS_DIR ?? join(HERE, '..', 'fixtures', 'assertions');
}
// score() loads the weights file relative to the tool ROOT, so this stays a
// tool-relative path. The fixture weights carry verified:false, which is what
// keeps `submittable` false no matter how clean the arithmetic looks.
function weightsPath() {
  return process.env.CCP_WEIGHTS_PATH ?? 'fixtures/sprs-weights.fixture.yaml';
}

/**
 * The five NDAA-driven regimes (plus the adjacent FASCSA authority) that the one
 * inventory crosswalks into. Each regime is matched against the REAL crosswalk
 * edges on the loaded controls, so the "one inventory, regimes as edges" idea is
 * shown from the data rather than asserted. See README "The framing".
 */
const REGIMES = [
  {
    key: 'cmmc-l2',
    name: 'CMMC 2.0 Level 2',
    driver: 'FY2020 NDAA',
    rule: 'DFARS 252.204-7021 / 32 CFR Part 170 · NIST SP 800-171 Rev 2',
    demands: 'Assessment, SPRS score, POA&M with a closeout clock',
    match: (e) => e.framework === 'nist800171r2',
  },
  {
    key: 'dfars-7012',
    name: 'Safeguarding CDI + incident reporting',
    driver: 'pre-dates the NDAA',
    rule: 'DFARS 252.204-7012',
    demands: '72-hour DIBNet report from discovery, 90-day image preservation, DC3 submission, flow-down',
    match: (e) => e.framework === 'dfars',
  },
  {
    key: 'sec889',
    name: 'Covered telecom / video surveillance',
    driver: 'FY2019 NDAA §889',
    rule: 'FAR 52.204-24 / -25',
    demands: 'Annual representation of no covered use',
    match: (e) => e.framework === 'far' && /52\.204-2[45]/.test(e.reference),
  },
  {
    key: 'sec1260h',
    name: 'Chinese Military Companies list',
    driver: 'FY2021 NDAA §1260H',
    rule: 'DoD-published list + implementing clause',
    demands: 'No contracting with a listed entity; diligence to catch affiliates',
    match: (e) => e.framework === 'far' && /1260H/i.test(e.reference),
  },
  {
    key: 'sec866',
    name: 'Cyber requirement harmonization',
    driver: 'FY2026 NDAA §866',
    rule: 'forthcoming',
    demands: 'Anticipate, do not front-run — be crosswalk-ready',
    match: () => false,
  },
  {
    key: 'fascsa',
    name: 'Supply chain security (adjacent)',
    driver: 'FASCSA 2018 — not an NDAA section',
    rule: 'FAR subpart 4.23',
    demands: 'FASC exclusion and removal orders',
    match: (e) => e.framework === 'fasc',
  },
];

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function buildRegimes(controls) {
  return REGIMES.map((r) => {
    const edges = [];
    for (const c of controls) {
      for (const e of c.crosswalk ?? []) {
        if (r.match(e)) edges.push({ control_id: c.control_id, reference: e.reference, confidence: e.confidence });
      }
    }
    const controlIds = [...new Set(edges.map((e) => e.control_id))];
    return { ...r, match: undefined, edges, edge_count: edges.length, control_count: controlIds.length, control_ids: controlIds };
  });
}

function emitOscal(assertions) {
  // Point-in-time package for the assessor (latest per control); the full history
  // drives VF/VD for the risk layer. This mirrors src/cli.mjs `emit all` exactly.
  const history = assertions;
  const latest = latestPerControl(history);
  const measured = variance(history).rows;

  const docs = [
    ['oscal-catalog.json', 'O2 Catalog', catalog()],
    ...profiles().map((p) => [`oscal-profile-${p.key}.json`, 'O2 Profile', p.doc]),
    ['oscal-component-definition.json', 'O1 Component definition', componentDefinition({ measured })],
    ['oscal-assessment-plan.json', 'O3 Assessment plan', assessmentPlan()],
    ['oscal-assessment-results.json', 'O3 Assessment results', assessmentResults(latest, { measured })],
    ['oscal-poam.json', 'O4 POA&M', poam(latest).doc],
    ['oscal-ssp.json', 'O5 System security plan', ssp(latest)],
  ];

  const outDir = mkdtempSync(join(tmpdir(), 'ccp-oscal-'));
  const files = [];
  try {
    for (const [name, model, doc] of docs) {
      const body = serialize(doc);
      const path = join(outDir, name);
      writeFileSync(path, body);
      const bytes = statSync(path).size;
      files.push({
        name,
        model,
        bytes,
        // A short preview so a non-expert sees it is real OSCAL JSON without a 60 KB dump.
        preview: body.length > 1400 ? body.slice(0, 1400) + '\n… (' + bytes + ' bytes total)' : body,
      });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  return { files, count: files.length };
}

async function main() {
  const req = await readStdin();
  const want = {
    coverage: req?.sections?.coverage !== false,
    sprs: req?.sections?.sprs !== false,
    variance: req?.sections?.variance !== false,
    oscal: req?.sections?.oscal !== false,
  };
  const started = Date.now();

  const dir = assertionsDir();
  if (!existsSync(dir)) throw new Error(`bundled fixture assertions not found at ${dir}`);
  const assertions = loadAssertions(dir);
  if (assertions.length === 0) throw new Error(`no assertion records found in ${dir}`);

  // Target-policy guard: the GUI only ever runs the offline fixture path. If the
  // evidence set is not fixture-stamped, refuse rather than render real evidence.
  const isFixture = isFixtureSet(assertions);
  if (!isFixture) {
    throw new Error('refusing to run: the assertion set is not fixture-stamped. This GUI only ever renders the bundled synthetic demo.');
  }

  const controls = loadControls();

  const inventory = controls.map((c) => ({
    control_id: c.control_id,
    title: c.title,
    status: c.status,
    layer: c.layer,
    owner: c.owner,
    assertion: c.assertion,
    population_definition: c.population_definition,
    split_rationale: c.split_rationale ?? null,
    faircam: (c.faircam ?? []).map((f) => ({ function: f.function, primary: !!f.primary })),
    crosswalk: (c.crosswalk ?? []).map((e) => ({
      framework: e.framework,
      reference: e.reference,
      confidence: e.confidence,
      basis: e.basis,
    })),
  }));

  const crosswalkEdges = inventory.reduce((n, c) => n + c.crosswalk.length, 0);

  // Latest assertion per control — the raw records the SPRS score is derived from.
  const latestAssertions = latestPerControl(assertions).map((a) => ({
    control_id: a.control_id,
    as_of: a.as_of,
    total: a.total ?? null,
    passing_count: a.passing_count ?? null,
    failing_count: a.failing_count ?? null,
    failing_enumerated: Array.isArray(a.failing) ? a.failing.length : null,
    population_definition: a.population_definition ?? null,
    query_ref: a.query_ref ?? null,
    fixture: a.fixture === true,
  }));

  const result = {
    toolVersion: '0.1.0',
    node: process.version,
    fixtureStamp: FIXTURE_STAMP,
    isFixture,
    assertionsDir: dir,
    controlCount: inventory.length,
    crosswalkEdges,
    inventory,
    regimes: buildRegimes(controls),
    latestAssertions,
  };

  if (want.coverage) result.coverage = summariseCoverage(coverage());

  if (want.sprs) {
    try {
      result.sprs = summariseSprs(score({ assertions, weightsPath: weightsPath() }), weightsPath());
    } catch (err) {
      if (err instanceof UnverifiedWeights) {
        result.sprs = { computed: false, refused: true, message: err.message, weightsPath: weightsPath() };
      } else {
        throw err;
      }
    }
  }

  if (want.variance) result.variance = { rows: variance(assertions).rows };

  if (want.oscal) result.oscal = emitOscal(assertions);

  result.durationMs = Date.now() - started;
  process.stdout.write(JSON.stringify(result));
}

function summariseCoverage(c) {
  return {
    requirement_count: c.requirement_count,
    operating: c.operating,
    intended: c.intended,
    weak: c.weak,
    uncovered: c.uncovered,
    // The mapped requirements are the actionable list; the 104 uncovered ids are
    // summarized by count here (the CLI enumerates them — that is the Phase 1 backlog).
    mapped: c.rows.filter((r) => r.state !== 'uncovered'),
  };
}

function summariseSprs(s, path) {
  const stateCounts = {};
  for (const r of s.results) stateCounts[r.basis] = (stateCounts[r.basis] ?? 0) + 1;
  return {
    computed: true,
    refused: false,
    weightsPath: path,
    score: s.score,
    basis: s.basis,
    deduction: s.deduction,
    met: s.met,
    unmet: s.unmet,
    at_or_above_conditional_threshold: s.at_or_above_conditional_threshold,
    weights_verified: s.weights_verified,
    evidence_is_fixture: s.evidence_is_fixture,
    submittable: s.submittable,
    stateCounts,
  };
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err?.stack ?? err?.message ?? String(err) }));
  process.exit(1);
});
