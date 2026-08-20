import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, loadControls } from './lib/load.mjs';
import { loadConfig, missingEnv, CONFIG_FILE, resolvePath } from './config.mjs';
import { selectCollectors } from './collectors/registry.mjs';
import { TABLES, csvTemplate } from './collectors/tables.mjs';

/**
 * The "am I set up yet?" command, and the main thing standing between a junior analyst and giving
 * up on day two.
 *
 * Design rules:
 *   - Never just say something is missing. Say what to do about it, in one line, with the command.
 *   - Distinguish BLOCKING (nothing will run) from DEGRADED (runs, but a control is withheld) from
 *     FIXTURE (runs on bundled data). Those three feel identical in a log and are completely
 *     different situations.
 *   - Never print a secret, only whether it is set.
 */

const OK = 'ok  ';
const WARN = 'warn';
const FAIL = 'FAIL';

export function doctor({ env = process.env } = {}) {
  const checks = [];
  const add = (level, name, detail, fix) => checks.push({ level, name, detail, fix });

  // --- environment ---------------------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  add(
    major >= 22 ? OK : FAIL,
    'node',
    `v${process.versions.node}`,
    major >= 22 ? null : 'This project needs Node 22 or newer. Install it and re-run.'
  );

  let config;
  let configState = OK;
  try {
    config = loadConfig();
    if (config._usingExample) {
      configState = WARN;
      add(WARN, CONFIG_FILE, 'not found - using the bundled example, which reads only fixtures', 'npm run init');
    } else {
      add(OK, CONFIG_FILE, `valid (${config.organization.name}, ${config.boundary.approach} boundary)`, null);
    }
  } catch (err) {
    add(FAIL, CONFIG_FILE, err.message.split('\n')[0], 'npm run init');
    return summarise(checks, { config: null });
  }

  // --- the boundary decision -----------------------------------------------------------------
  if (config.boundary.approach === 'enterprise') {
    add(
      WARN,
      'boundary',
      'enterprise scope - every asset in the company is in the assessment',
      'Unless that is a deliberate, funded decision, boundary.approach: enclave is the cheaper and more defensible answer.'
    );
  }

  // --- affirming official --------------------------------------------------------------------
  if (!config.organization.affirming_official || /unassigned/i.test(config.organization.affirming_official)) {
    add(
      WARN,
      'affirming official',
      'not named',
      'Name the person who will affirm in SPRS. It is a personal attestation with real exposure; this tool never performs it.'
    );
  }

  // --- collectors ----------------------------------------------------------------------------
  const { chosen, skipped } = selectCollectors(config);
  const controlsWithSource = new Set();

  for (const c of chosen) {
    const provider = providerFor(c.name, config);
    const missing = missingEnv(provider, env);

    if (missing.length > 0) {
      add(
        WARN,
        c.name,
        `configured, but ${missing.join(', ')} not set - will run in fixture mode only`,
        `Set ${missing.join(' and ')} in your environment. See docs/SETUP.md for how to get them.`
      );
      continue;
    }

    if (c.name.startsWith('csv-') || c.name.startsWith('reference-')) {
      const state = csvState(c, config);
      add(state.level, c.name, state.detail, state.fix);
      if (state.level === OK) (TABLES[c.table]?.controls ?? []).forEach((x) => controlsWithSource.add(x));
      continue;
    }

    add(OK, c.name, 'configured with credentials present', null);
    (TABLES[c.table]?.controls ?? []).forEach((x) => controlsWithSource.add(x));
  }

  for (const s of skipped) {
    if (s.reason === 'not configured') continue;
    add(WARN, s.name, s.reason, null);
  }

  // --- which controls can actually produce evidence -------------------------------------------
  for (const control of loadControls()) {
    if (controlsWithSource.has(control.control_id)) continue;
    add(
      WARN,
      control.control_id,
      'no usable source - this control will be WITHHELD, not failed',
      'An unestablished population is never a pass. Wire its source or accept that it is unevidenced.'
    );
  }

  // --- the reference lists nobody can ship ----------------------------------------------------
  if (!config.reference?.entity_list_1260h_path || !existsSync(resolvePath(config.reference.entity_list_1260h_path))) {
    add(
      WARN,
      '1260H list',
      'not present',
      'This repository cannot ship it - it changes on a recurring cadence and a stale copy reads as ' +
        'screened. Export the current DoD-published list to CSV. See docs/SETUP.md.'
    );
  }

  return summarise(checks, { config, configState });
}

function providerFor(name, config) {
  if (name.startsWith('entra')) return 'entra';
  if (name.startsWith('azure')) return config.cloud.provider;
  if (name.startsWith('okta')) return 'okta';
  if (name.startsWith('aws')) return 'aws-govcloud';
  return 'csv';
}

/** A CSV source is legitimate, but it is a manual extract - so its age is part of the finding. */
function csvState(collector, config) {
  const key = keyFor(collector.name);
  const path = key ? key.split('.').reduce((o, k) => o?.[k], config) : null;
  const abs = resolvePath(path);

  if (!abs || !existsSync(abs)) {
    return {
      level: WARN,
      detail: `${path ?? 'no path configured'} not found`,
      fix: `npm run doctor -- --templates writes a header-only CSV you can fill in.`,
    };
  }
  const ageDays = Math.floor((Date.now() - statSync(abs).mtimeMs) / 86400000);
  return {
    level: ageDays > 45 ? WARN : OK,
    detail: `${path} (last updated ${ageDays} day(s) ago)`,
    fix:
      ageDays > 45
        ? 'A manual export this old is evidence of a past state. Refresh it, and put the refresh on a calendar.'
        : null,
  };
}

function keyFor(name) {
  return {
    'csv-suppliers': 'procurement.supplier_master_path',
    'csv-components': 'inventory.components_path',
    'csv-incidents': 'incident_response.incidents_path',
    'csv-dibnet-submissions': 'incident_response.submissions_path',
    'csv-identities': 'identity.csv_path',
    'csv-cloud-resources': 'cloud.csv_path',
    'csv-cmdb-assets': 'cmdb.assets_path',
    'csv-mdm-devices': 'mdm.devices_path',
    'reference-1260h': 'reference.entity_list_1260h_path',
    'reference-fasc': 'reference.fasc_orders_path',
    'reference-covered-telecom': 'reference.covered_telecom_path',
  }[name];
}

function summarise(checks, { config }) {
  return {
    checks,
    config,
    blocking: checks.filter((c) => c.level === FAIL).length,
    warnings: checks.filter((c) => c.level === WARN).length,
  };
}

/** Header-only CSVs so the analyst has something concrete to fill in. */
export function writeTemplates() {
  const dir = join(ROOT, 'inbox');
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [table, def] of Object.entries(TABLES)) {
    if (!def.required?.length) continue;
    const file = join(dir, `${table.replace(/^src_/, '')}.template.csv`);
    writeFileSync(file, csvTemplate(table));
    written.push(file.replace(ROOT, '.'));
  }
  return written;
}

export function formatDoctor({ checks, blocking, warnings }) {
  const out = [];
  out.push('cui-control-plane doctor');
  out.push('');
  for (const c of checks) {
    out.push(`  [${c.level}] ${c.name.padEnd(52)} ${c.detail}`);
    if (c.fix) out.push(`         -> ${c.fix}`);
  }
  out.push('');
  if (blocking > 0) {
    out.push(`${blocking} blocking problem(s). Nothing will run until those are fixed.`);
  } else if (warnings > 0) {
    out.push(
      `No blocking problems. ${warnings} warning(s) - the pipeline will run, and any control whose ` +
        'population cannot be established is WITHHELD rather than passed.'
    );
  } else {
    out.push('Everything configured. `npm run pipeline` will collect from real systems.');
  }
  return out.join('\n');
}
