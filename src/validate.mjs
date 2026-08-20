// ajv's default export is draft-07. The schemas here declare 2020-12, which needs this entry
// point - the default one fails with "no schema with key or ref .../2020-12/schema".
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  loadControls,
  loadRequirementIndex,
  loadScenarios,
  loadExceptions,
  loadSchema,
  fileExists,
  readRepoFile,
} from './lib/load.mjs';

/**
 * Schema validation plus the house rules that a JSON Schema cannot express.
 *
 * The house rules are the interesting half. Each one encodes a defect from the control-inventory
 * review checklist, so that the defect fails a build rather than surviving until an assessor
 * finds it.
 */

// Compiled once and memoised. Compiling per call re-registers the schema $id on the same Ajv
// instance, which throws "schema with key or id ... already exists" the second time validate() is
// called in a process - which is exactly what a test suite does.
const compiled = new Map();
function schemaValidator(name) {
  if (compiled.has(name)) return compiled.get(name);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const fn = ajv.compile(loadSchema(name));
  compiled.set(name, fn);
  return fn;
}

const QUANTIFIERS = ['every', 'no ', 'none', 'all ', 'each'];

/**
 * @param {object} [opts]
 * @param {object[]} [opts.controls] Control records to validate. Defaults to the live inventory.
 *   Injected rather than read from disk so that tests can prove each guard fires without writing
 *   defective records into controls/ - which races with anything else reading the inventory.
 */
export function validate({
  controls = loadControls(),
  scenarios = loadScenarios(),
  exceptions = loadExceptions(),
  today = null,
} = {}) {
  const errors = [];
  const warnings = [];

  const controlSchema = schemaValidator('control.schema.json');
  const index = loadRequirementIndex();

  if (controls.length === 0) errors.push('no control records found in controls/');

  const knownScenarios = new Set(scenarios.map((s) => s.scenario_id));
  const seen = new Map();
  // domain + final segment -> control_ids, used to detect layer splits that owe a rationale
  const splitGroups = new Map();

  for (const c of controls) {
    const where = c._file ?? c.control_id;
    const record = { ...c };
    delete record._file;

    if (!controlSchema(record)) {
      for (const e of controlSchema.errors) {
        errors.push(`${where}: schema ${e.instancePath || '/'} ${e.message}`);
      }
      continue;
    }

    // --- IDs are stable and never reused -------------------------------------------------
    if (seen.has(c.control_id)) {
      errors.push(`${where}: duplicate control_id ${c.control_id} (also ${seen.get(c.control_id)})`);
    }
    seen.set(c.control_id, where);

    // --- The assertion must quantify over a population -----------------------------------
    // "Access is reviewed periodically" is not an assertion. This is the single highest-value
    // piece of writing in the inventory and it is not a technical task, so the check is crude on
    // purpose: it catches the shape, and a human still has to make it true.
    const assertion = (c.assertion ?? '').toLowerCase();
    if (!QUANTIFIERS.some((q) => assertion.includes(q))) {
      errors.push(
        `${where}: assertion does not quantify over a population - expected one of ` +
          `${QUANTIFIERS.map((q) => q.trim()).join(', ')}`
      );
    }

    // --- query_ref must exist, and must be the model it claims ---------------------------
    if (!fileExists(c.query_ref)) {
      errors.push(`${where}: query_ref ${c.query_ref} does not exist - the control is unmeasurable`);
    } else {
      const sql = readRepoFile(c.query_ref);
      if (!sql.includes(c.control_id)) {
        errors.push(`${where}: query_ref ${c.query_ref} never mentions ${c.control_id}`);
      }
      // --- population_definition prose vs. the model's own declared population -----------
      // Full prose-to-SQL equivalence is not decidable, so the model restates its population in a
      // header block and this checks the two restatements agree on their distinctive words. It
      // catches the drift that actually happens: a where clause edited without the record, or the
      // reverse.
      const declared = extractDeclaredPopulation(sql);
      if (declared === null) {
        errors.push(
          `${where}: ${c.query_ref} has no "population_definition (must match the where clause below)" ` +
            'header block, so record-to-model drift cannot be checked'
        );
      } else if (!populationsAgree(c.population_definition, declared)) {
        errors.push(
          `${where}: population_definition in the record and in ${c.query_ref} have drifted apart. ` +
            'Prose and query must agree; drift between them is a finding.'
        );
      }
    }

    // --- Policy last ---------------------------------------------------------------------
    if (c.policy_ref && c.status !== 'operating') {
      errors.push(
        `${where}: policy_ref is set but status is "${c.status}". Never publish a policy for a ` +
          'control that is not operating - build it, instrument it, observe it holding, then generate ' +
          'the expectation from it.'
      );
    }

    // --- Exactly one primary FAIR-CAM function -------------------------------------------
    const primaries = (c.faircam ?? []).filter((f) => f.primary).length;
    if (primaries !== 1) {
      errors.push(`${where}: expected exactly one primary FAIR-CAM function, found ${primaries}`);
    }

    // --- Crosswalk targets must exist in the requirement index ---------------------------
    for (const edge of c.crosswalk ?? []) {
      if (edge.framework !== 'nist800171r2') continue;
      if (!index.requirements.some((r) => r.id === edge.reference)) {
        errors.push(
          `${where}: crosswalk to 800-171 ${edge.reference}, which is not one of the ` +
            `${index.requirement_count} requirements in the index`
        );
      }
    }

    // --- Unpriced controls, and dangling scenario references -----------------------------
    if (!c.scenarios || c.scenarios.length === 0) {
      warnings.push(`${where}: no scenario - the control is unpriced. Find its scenario or ask why it exists.`);
    }
    for (const ref of c.scenarios ?? []) {
      if (!knownScenarios.has(ref)) {
        errors.push(
          `${where}: references ${ref}, which is not in the scenario registry. A control pointing at ` +
            'a scenario nobody wrote is not priced, it only looks priced.'
        );
      }
    }

    const [, domain, , leaf] = c.control_id.split('.');
    const key = `${domain}|${leaf}`;
    splitGroups.set(key, [...(splitGroups.get(key) ?? []), c]);
  }

  // --- A layer split owes a rationale ------------------------------------------------------
  for (const [key, group] of splitGroups) {
    if (group.length < 2) continue;
    for (const c of group) {
      if (!c.split_rationale) {
        errors.push(
          `${c._file}: ${c.control_id} shares "${key.replace('|', '.*.')}" with ` +
            `${group.filter((g) => g !== c).map((g) => g.control_id).join(', ')} but has no ` +
            'split_rationale. State which of owner / cost / threat model / failure mode differs, ' +
            'or merge them.'
        );
      }
    }
  }

  // --- Every control model reaches the variance layer --------------------------------------
  const union = fileExists('models/intermediate/control_results_all.sql')
    ? readRepoFile('models/intermediate/control_results_all.sql')
    : '';
  for (const c of controls) {
    const modelName = c.query_ref.split('/').pop().replace('.sql', '');
    if (!union.includes(`'${modelName}'`)) {
      errors.push(
        `${c._file}: ${modelName} is not unioned into models/intermediate/control_results_all.sql, ` +
          'so it never reaches the variance layer and produces no VF/VD.'
      );
    }
  }

  // --- Scenarios ---------------------------------------------------------------------------
  const scenarioSchema = schemaValidator('scenario.schema.json');
  const referenced = new Set(controls.flatMap((c) => c.scenarios ?? []));
  for (const sc of scenarios) {
    const where = sc._file ?? sc.scenario_id;
    const record = { ...sc };
    delete record._file;
    if (!scenarioSchema(record)) {
      for (const e of scenarioSchema.errors) {
        errors.push(`${where}: schema ${e.instancePath || '/'} ${e.message}`);
      }
      continue;
    }
    // A scenario no control serves is either an unaddressed risk or a scenario nobody meant.
    // Both are worth surfacing; neither is a build failure.
    if (!referenced.has(sc.scenario_id) && sc.status !== 'retired') {
      warnings.push(
        `${where}: no control references this scenario - it is either an unaddressed risk or a ` +
          'scenario nobody chose. Say which.'
      );
    }
    // Quantification that appears without a confidence tier is a number with no provenance, and a
    // range with no provenance must not read as authoritative as a sourced one.
    const q = sc.quantification ?? {};
    if ((q.lef || q.lm) && (q.confidence_tier === null || q.confidence_tier === undefined)) {
      errors.push(
        `${where}: carries a quantification with no confidence_tier. Every number carries its ` +
          'derivation level and confidence, or it does not go in.'
      );
    }
  }

  // --- Exceptions --------------------------------------------------------------------------
  // An approved exception is reduced coverage with an expiry, never a pass.
  const exceptionSchema = schemaValidator('exception.schema.json');
  const asOf = today ?? new Date().toISOString().slice(0, 10);
  const knownControls = new Set(controls.map((c) => c.control_id));
  for (const ex of exceptions) {
    const where = ex._file ?? ex.exception_id;
    const record = { ...ex };
    delete record._file;
    if (!exceptionSchema(record)) {
      for (const e of exceptionSchema.errors) {
        errors.push(`${where}: schema ${e.instancePath || '/'} ${e.message}`);
      }
      continue;
    }
    if (!knownControls.has(ex.control_id)) {
      errors.push(`${where}: exception against ${ex.control_id}, which is not in the inventory.`);
    }
    if (ex.expires_at <= ex.granted_at) {
      errors.push(`${where}: expires_at (${ex.expires_at}) is not after granted_at (${ex.granted_at}).`);
    }
    // An expired exception has silently become an undocumented control change. It is a build
    // failure rather than a warning, because the alternative is that it stays expired forever and
    // the population it excludes goes on being excluded without anybody re-approving it.
    if (ex.expires_at < asOf) {
      errors.push(
        `${where}: EXPIRED on ${ex.expires_at} (today is ${asOf}) and is still in the register. ` +
          'Renew it, remove it, or change the control - an expired exception is an undocumented ' +
          'control change.'
      );
    }
    if ((ex.compensating ?? []).length === 0) {
      warnings.push(
        `${where}: no compensating controls recorded. That is a legitimate statement - nothing ` +
          'holds this risk down - but it is one somebody should be owning deliberately.'
      );
    }
  }

  return {
    errors,
    warnings,
    controlCount: controls.length,
    scenarioCount: scenarios.length,
    exceptionCount: exceptions.length,
  };
}

/** Pulls the population restatement out of a control model's header comment. */
export function extractDeclaredPopulation(sql) {
  const start = sql.indexOf('population_definition (must match');
  if (start === -1) return null;
  const lines = sql.slice(start).split('\n').slice(1);
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('--')) break;
    const body = line.replace(/^--\s?/, '');
    if (body.trim() === '') break;
    out.push(body.trim());
  }
  return out.join(' ').trim() || null;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'with', 'is', 'are', 'all', 'every',
  'that', 'this', 'their', 'its', 'as', 'by', 'on', 'at', 'from', 'not', 'no', 'which', 'them',
  'those', 'be', 'been', 'it', 'they', 'them',
]);

const significant = (s) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );

/**
 * Jaccard overlap on significant words. Deliberately loose: the record's prose is written for an
 * assessor and the model's restatement is written for an engineer, so they will never be
 * identical. The threshold catches a where clause edited without its record, which is the drift
 * that actually happens, without failing on ordinary rewording.
 */
export function populationsAgree(recordProse, modelProse, threshold = 0.5) {
  const a = significant(recordProse);
  const b = significant(modelProse);
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.min(a.size, b.size) >= threshold;
}
