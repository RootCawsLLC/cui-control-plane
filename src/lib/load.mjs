import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readYaml = (p) => parse(read(p));

/** Control records, sorted by control_id so every downstream artifact orders identically. */
export function loadControls() {
  const dir = join(ROOT, 'controls');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ ...parse(readFileSync(join(dir, f), 'utf8')), _file: `controls/${f}` }))
    .sort((a, b) => a.control_id.localeCompare(b.control_id));
}

export const loadRequirementIndex = () => readYaml('reference/nist-800-171r2.index.yaml');

/** Risk scenarios. The join from controls to loss events; see schemas/scenario.schema.json. */
export const loadScenarios = () => loadYamlDir('scenarios', 'scenario_id');

/** Approved exceptions - reduced coverage with an expiry, never a pass. */
export const loadExceptions = () => loadYamlDir('exceptions', 'exception_id');

function loadYamlDir(dir, sortKey) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ ...parse(readFileSync(join(abs, f), 'utf8')), _file: `${dir}/${f}` }))
    .sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])));
}

export const loadWeights = (path = 'reference/sprs-weights.yaml') => readYaml(path);

/**
 * Assertion records from a directory of JSON files.
 *
 * Sorted by (control_id, as_of) rather than by filename: filenames are a storage detail and
 * sorting by them would let a rename reorder an OSCAL export, producing a diff that represents
 * nothing. Deterministic ordering is half of what makes these artifacts reviewable; the other
 * half is the v5 UUIDs.
 */
export function loadAssertions(dir) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(abs, f), 'utf8')))
    .sort((a, b) => a.control_id.localeCompare(b.control_id) || a.as_of.localeCompare(b.as_of));
}

export const loadSchema = (name) => JSON.parse(read(`schemas/${name}`));

export const fileExists = (p) => existsSync(join(ROOT, p));

export const readRepoFile = (p) => read(p);

/**
 * True when any assertion in the set is synthetic. Once true it stays true through every
 * downstream artifact - a package built from a mix of real and fixture evidence is a fixture
 * package, and rounding that up to "real" is the single most damaging thing a generator can do.
 */
export const isFixtureSet = (assertions) => assertions.some((a) => a.fixture === true);

/**
 * The most recent assertion per control.
 *
 * The OSCAL package is a point-in-time assessment: O3, O4 and O5 describe the state as of one
 * moment. Feeding them the full history would emit one finding per control PER SNAPSHOT and, worse,
 * duplicate POA&M items that collide on the same deterministic UUID - the same weakness listed
 * three times, or listed once with the count silently wrong.
 *
 * The history is not discarded, it belongs to a different consumer: src/variance.mjs walks every
 * snapshot to derive VF and VD. Point-in-time for the assessor, time series for the risk layer.
 */
export function latestPerControl(assertions) {
  const latest = new Map();
  for (const a of assertions) {
    const prev = latest.get(a.control_id);
    if (!prev || a.as_of > prev.as_of) latest.set(a.control_id, a);
  }
  return [...latest.values()].sort((a, b) => a.control_id.localeCompare(b.control_id));
}

export const FIXTURE_STAMP = 'NOT REAL EVIDENCE';
