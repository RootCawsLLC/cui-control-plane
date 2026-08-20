import { createInterface } from 'node:readline/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

import { configPath, CONFIG_FILE } from './config.mjs';
import { ROOT } from './lib/load.mjs';
import { join } from 'node:path';

/**
 * The interview. Twelve questions, every one with a default that works.
 *
 * Design rule: a junior analyst who presses Enter twelve times must end up with a VALID config that
 * runs end to end against fixtures. Nothing here may require a value the person does not have on
 * their first day - anything that needs a credential is asked for as a *choice of provider*, and
 * the credential itself is an environment variable they wire up later, guided by `ccp doctor`.
 *
 * Every question carries a `why` explaining which artifact changes if the answer changes. That is
 * a rule borrowed from grc-wizard: if you cannot write the `why`, the question does not go in.
 */

const QUESTIONS = [
  {
    key: 'organization.name',
    q: 'Organisation name',
    def: 'Example Defense Systems',
    why: 'Appears in the SSP, the assessment plan and the Section 889 representation.',
  },
  {
    key: 'organization.cage_code',
    q: 'CAGE code (blank if you do not have one to hand)',
    def: '',
    why: 'Identifies the entity in SPRS. Optional here; required before an actual submission.',
  },
  {
    key: 'organization.affirming_official',
    q: 'Affirming official (the person who will affirm in SPRS)',
    def: '',
    why: 'Recorded because the affirmation is a personal attestation. This tool never performs it.',
  },
  {
    key: 'boundary.approach',
    q: 'CUI boundary approach',
    def: 'enclave',
    choices: ['enclave', 'enterprise'],
    why: 'The Phase 0 decision. Enclave keeps assessment cost and control count bounded; enterprise puts the whole estate in scope.',
  },
  {
    key: 'boundary.name',
    q: 'What do you call that boundary',
    def: 'CUI enclave',
    why: 'Used as the system name in the SSP.',
  },
  {
    key: 'identity.provider',
    q: 'Identity provider for the enclave',
    def: 'entra',
    choices: ['entra', 'okta', 'csv', 'none'],
    why: 'Decides which collector reads your identities. `csv` means you export a user list yourself - always available, never continuous.',
  },
  {
    key: 'identity.cloud_environment',
    q: 'Microsoft cloud environment',
    def: 'usgov',
    choices: ['commercial', 'usgov'],
    why: 'GCC High and DoD tenants use graph.microsoft.us. Choosing wrong here is the usual cause of a 401 that looks like a permissions problem.',
    when: (a) => a['identity.provider'] === 'entra',
  },
  {
    key: 'identity.break_glass_attribute',
    q: 'User attribute marking break-glass accounts (blank if none)',
    def: 'extensionAttribute1',
    why: 'Break-glass accounts are excluded from the MFA population and carried by a separate control. An attribute, never a name pattern.',
    when: (a) => a['identity.provider'] === 'entra',
  },
  {
    key: 'cloud.provider',
    q: 'Cloud hosting the enclave',
    def: 'azure-gov',
    choices: ['azure-gov', 'azure', 'aws-govcloud', 'csv', 'none'],
    why: 'Decides which collector enumerates enclave assets - the denominator every other control depends on.',
  },
  {
    key: 'procurement.source',
    q: 'Supplier master source',
    def: 'csv',
    choices: ['csv', 'none'],
    why: 'Population for BOTH the Section 1260H screening control and the Section 889 attestation. A CSV export from procurement is enough to start.',
  },
  {
    key: 'inventory.source',
    q: 'Component / hardware inventory source',
    def: 'csv',
    choices: ['csv', 'none'],
    why: 'Population for the Section 889 covered-equipment control.',
  },
  {
    key: 'incident_response.source',
    q: 'Incident record source',
    def: 'csv',
    choices: ['csv', 'none'],
    why: 'Population for the DFARS 7012 72-hour reporting control.',
  },
];

function set(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    node[p] ??= {};
    node = node[p];
  }
  node[parts.at(-1)] = value;
}

export function buildConfig(answers) {
  const c = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === '' || v === undefined) continue;
    set(c, k, v);
  }

  c.organization ??= { name: 'Example Defense Systems' };
  c.boundary ??= { approach: 'enclave', name: 'CUI enclave' };
  c.identity ??= { provider: 'none' };
  c.cloud ??= { provider: 'none' };
  c.procurement ??= { source: 'none' };
  c.inventory ??= { source: 'none' };
  c.incident_response ??= { source: 'none' };

  // Paths are filled in for every csv source so the analyst has somewhere concrete to put a file
  // rather than having to invent a convention.
  if (c.procurement.source === 'csv') c.procurement.supplier_master_path ??= 'inbox/suppliers.csv';
  if (c.inventory.source === 'csv') c.inventory.components_path ??= 'inbox/components.csv';
  if (c.incident_response.source === 'csv') {
    c.incident_response.incidents_path ??= 'inbox/incidents.csv';
    c.incident_response.submissions_path ??= 'inbox/dibnet-submissions.csv';
  }
  if (c.identity.provider === 'csv') c.identity.csv_path ??= 'inbox/identities.csv';
  if (c.cloud.provider === 'csv') c.cloud.csv_path ??= 'inbox/assets.csv';

  c.reference = {
    covered_telecom_path: 'reference/covered-telecom.seed.csv',
    entity_list_1260h_path: 'inbox/entity-list-1260h.csv',
    fasc_orders_path: 'inbox/fasc-orders.csv',
    ...c.reference,
  };
  c.warehouse = { engine: 'duckdb', path: '.warehouse/ccp.duckdb' };
  c.evidence = { path: '.evidence', retain_days: 400 };
  return c;
}

export function toYaml(config) {
  const lines = [
    '# ccp.config.yaml - the one file this organisation edits.',
    '#',
    '# NO CREDENTIALS HERE. Secrets come from environment variables; run `npm run doctor` and it',
    '# will tell you exactly which ones it wants and which are missing. This file is safe to commit',
    '# to your own repository.',
    '#',
    '# Regenerate with `npm run init`. Check with `npm run doctor`.',
    '',
  ];

  const emit = (obj, indent = 0) => {
    for (const [k, v] of Object.entries(obj)) {
      const pad = ' '.repeat(indent);
      if (Array.isArray(v)) {
        lines.push(`${pad}${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
      } else if (v && typeof v === 'object') {
        lines.push(`${pad}${k}:`);
        emit(v, indent + 2);
      } else if (typeof v === 'string') {
        lines.push(`${pad}${k}: ${JSON.stringify(v)}`);
      } else {
        lines.push(`${pad}${k}: ${v}`);
      }
    }
  };
  emit(config);
  return `${lines.join('\n')}\n`;
}

export async function init({ force = false, file = CONFIG_FILE } = {}) {
  const path = configPath(file);
  if (existsSync(path) && !force) {
    console.log(`${file} already exists. Re-run with --force to overwrite it.`);
    return 1;
  }

  console.log('Setting up cui-control-plane.\n');
  console.log('Twelve questions. Every one has a working default, so pressing Enter throughout');
  console.log('gives you a valid config that runs end to end against the bundled fixtures.\n');

  const rl = createInterface({ input: stdin, output: stdout });
  const answers = {};
  try {
    for (const q of QUESTIONS) {
      if (q.when && !q.when(answers)) continue;
      const choices = q.choices ? ` (${q.choices.join(' / ')})` : '';
      const def = q.def === '' ? '' : ` [${q.def}]`;
      console.log(`\n  why: ${q.why}`);
      let value = (await rl.question(`${q.q}${choices}${def}: `)).trim();
      if (value === '') value = q.def;
      if (q.choices && !q.choices.includes(value)) {
        console.log(`  not one of ${q.choices.join(', ')} - using ${q.def}`);
        value = q.def;
      }
      answers[q.key] = value;
    }
  } finally {
    rl.close();
  }

  const config = buildConfig(answers);
  writeFileSync(path, toYaml(config));

  // Somewhere concrete to put files beats a convention the analyst has to infer.
  mkdirSync(join(ROOT, 'inbox'), { recursive: true });

  console.log(`\nWrote ${file}.\n`);
  console.log('Next:');
  console.log('  npm run doctor      what is configured, what is missing, and what will run');
  console.log('  npm run collect     gather evidence (add --fixture to run with no credentials)');
  console.log('  npm run pipeline    collect, build, assert, and emit the whole package');
  console.log('\nSee docs/SETUP.md for the guided walkthrough.');
  return 0;
}
