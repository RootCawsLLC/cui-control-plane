import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { runPipeline, buildAssertion, firstObserved } from '../src/pipeline.mjs';
import { render } from '../src/warehouse.mjs';
import { parseCsv, readCsvObjects, normaliseEntityName, csvBool } from '../src/collectors/lib/csv.mjs';
import { grade as gradeEntra, normaliseMethod } from '../src/collectors/entra-identities.mjs';
import { classify } from '../src/collectors/lib/graph.mjs';
import { selectCollectors } from '../src/collectors/registry.mjs';
import { TABLES, columnType } from '../src/collectors/tables.mjs';

// ---------------------------------------------------------------------------------------------
// CSV. The universal adapter, so its edge cases are the ones an analyst will actually hit.
// ---------------------------------------------------------------------------------------------
test('csv handles quotes, embedded commas and newlines', () => {
  const rows = parseCsv('a,b\n"x,1","line\nbreak"\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,1', 'line\nbreak'],
  ]);
});

test('csv strips the BOM Excel writes, which otherwise corrupts the first header', () => {
  const { headers } = readCsvObjects('﻿supplier_id,legal_name\nS1,Acme\n');
  assert.equal(headers[0], 'supplier_id');
});

test('csv headers are normalised so an export does not have to be hand-edited', () => {
  const { objects } = readCsvObjects('Supplier ID,Legal-Name\nS1,Acme\n');
  assert.equal(objects[0].supplier_id, 'S1');
  assert.equal(objects[0].legal_name, 'Acme');
});

test('csv reports missing required columns rather than failing downstream on a null', () => {
  const { missing } = readCsvObjects('legal_name\nAcme\n', { required: ['supplier_id', 'legal_name'] });
  assert.deepEqual(missing, ['supplier_id']);
});

test('spreadsheet booleans are read the way people actually write them', () => {
  for (const v of ['TRUE', 'yes', 'Y', '1']) assert.equal(csvBool(v), true, v);
  for (const v of ['false', 'no', '', 'maybe']) assert.equal(csvBool(v), false, v);
});

test('entity normalisation strips corporate suffixes but is not fuzzy', () => {
  assert.equal(normaliseEntityName('Hytera Communications Corporation'), 'hytera communications');
  assert.equal(normaliseEntityName('Hytera Communications Corp.'), 'hytera communications');
  // Deliberately NOT a similarity match - a screening result nobody can reproduce is not evidence.
  assert.notEqual(normaliseEntityName('Hytera Comms'), normaliseEntityName('Hytera Communications'));
});

// ---------------------------------------------------------------------------------------------
// Entra grading - pure, so it is testable without a tenant.
// ---------------------------------------------------------------------------------------------
const config = { identity: { phishing_resistant_methods: ['fido2SecurityKey', 'x509Certificate'] } };

test('a user absent from the registration report has no factors, which is a real answer', () => {
  const rows = gradeEntra({
    users: [{ id: 'u1', userPrincipalName: 'a@x', accountEnabled: true, userType: 'Member' }],
    registration: [],
    config,
    collectedAt: '2026-08-20T00:00:00Z',
  });
  assert.equal(rows[0].factor_count, 0);
  assert.equal(rows[0].strongest_factor_type, null);
});

test('a registered non-phishing-resistant factor counts but is not scored as resistant', () => {
  const rows = gradeEntra({
    users: [{ id: 'u1', accountEnabled: true, userType: 'Member' }],
    registration: [{ id: 'u1', methodsRegistered: ['microsoftAuthenticatorPush'] }],
    config,
    collectedAt: '2026-08-20T00:00:00Z',
  });
  assert.equal(rows[0].factor_count, 1);
  assert.notEqual(rows[0].strongest_factor_type, 'webauthn');
});

test('certificate-based auth maps to piv_cac, the shape this domain actually deploys', () => {
  assert.equal(normaliseMethod('x509Certificate', new Set(['x509Certificate'])), 'piv_cac');
});

test('guests are excluded by default and the exclusion is visible in the row count', () => {
  const rows = gradeEntra({
    users: [
      { id: 'u1', accountEnabled: true, userType: 'Member' },
      { id: 'g1', accountEnabled: true, userType: 'Guest' },
    ],
    registration: [],
    config,
    collectedAt: '2026-08-20T00:00:00Z',
  });
  assert.equal(rows.length, 1);
});

test('a 403 that mentions consent is a permission problem, not an auth one', () => {
  assert.equal(classify(403, { error: { message: 'Authorization_RequestDenied' } }), 'permission');
  assert.equal(classify(401, {}), 'auth');
  assert.equal(classify(429, {}), 'throttled');
});

// ---------------------------------------------------------------------------------------------
// The dbt shim.
// ---------------------------------------------------------------------------------------------
test('the runner resolves the three dbt functions the models use', () => {
  const sql = render(
    "select '{{ var(\"as_of\") }}' from {{ ref('stg_x') }} join {{ source('procurement','supplier_master') }} on true",
    { asOf: '2026-08-20T00:00:00Z' }
  );
  assert.match(sql, /stg_x/);
  assert.match(sql, /src_procurement_supplier_master/);
  assert.match(sql, /2026-08-20T00:00:00Z/);
});

test('an unsupported dbt expression fails loudly rather than rendering to something surprising', () => {
  assert.throws(() => render("select {{ dbt_utils.star(from=ref('x')) }}", { asOf: 'x' }), /unsupported dbt expression/);
});

// ---------------------------------------------------------------------------------------------
// Landing tables.
// ---------------------------------------------------------------------------------------------
test('landing columns get real types, not everything-as-text', () => {
  assert.equal(columnType('snapshot_at'), 'TIMESTAMP');
  assert.equal(columnType('factor_count'), 'INTEGER');
  assert.equal(columnType('is_break_glass'), 'BOOLEAN');
  assert.equal(columnType('policy_exemptions'), 'VARCHAR[]');
  assert.equal(columnType('legal_name'), 'VARCHAR');
});

test('every table declares which controls depend on it', () => {
  for (const [name, def] of Object.entries(TABLES)) {
    assert.ok(def.controls.length > 0, `${name} feeds no control`);
    assert.ok(def.columns.length > 0, `${name} has no columns`);
  }
});

// ---------------------------------------------------------------------------------------------
// Collector selection is explicit, never "whatever credentials happen to exist".
// ---------------------------------------------------------------------------------------------
test('an unbuilt provider is skipped with a route to a working alternative', () => {
  const { chosen, skipped } = selectCollectors({
    identity: { provider: 'okta' },
    cloud: { provider: 'none' },
    procurement: {},
    inventory: {},
    incident_response: {},
    reference: {},
  });
  assert.ok(!chosen.some((c) => c.name.includes('okta')));
  const okta = skipped.find((s) => s.name === 'okta-identities');
  assert.match(okta.reason, /identity.provider: csv/);
});

// ---------------------------------------------------------------------------------------------
// The assertion builder. These three are the rules that keep the output honest.
// ---------------------------------------------------------------------------------------------
const control = {
  control_id: 'ctl.x.y.z',
  population_definition: 'probe population',
  source_system: 'probe',
  query_ref: 'models/controls/probe.sql',
};

test('a NULL passing value is a failure, never a pass', () => {
  // SQL three-valued logic: the never-screened supplier arrives as NULL, and NULL is not true.
  const a = buildAssertion({
    control,
    rows: [{ subject_id: 's1', passing: null, reason: 'never_screened' }],
    asOf: '2026-08-20T00:00:00Z',
    fixture: true,
  });
  assert.equal(a.failing_count, 1);
  assert.equal(a.passing_count, 0);
});

test('counts always reconcile against the population', () => {
  const a = buildAssertion({
    control,
    rows: [
      { subject_id: 's1', passing: true },
      { subject_id: 's2', passing: false, reason: 'x' },
      { subject_id: 's3', passing: null, reason: 'y' },
    ],
    asOf: '2026-08-20T00:00:00Z',
    fixture: true,
  });
  assert.equal(a.total, 3);
  assert.equal(a.passing_count + a.failing_count, a.total);
  assert.equal(a.failing.length, a.failing_count);
});

test('first_observed comes from prior evidence, so duration is not reset to zero every run', () => {
  const history = [
    { as_of: '2026-08-01T00:00:00Z', failing: [{ subject_id: 's1' }] },
    { as_of: '2026-08-08T00:00:00Z', failing: [{ subject_id: 's1' }] },
  ];
  assert.equal(firstObserved(history, 's1', '2026-08-15T00:00:00Z'), '2026-08-01T00:00:00Z');
});

test('a subject that recovered and failed again starts a NEW clock', () => {
  const history = [
    { as_of: '2026-08-01T00:00:00Z', failing: [{ subject_id: 's1' }] },
    { as_of: '2026-08-08T00:00:00Z', failing: [] },
    { as_of: '2026-08-15T00:00:00Z', failing: [{ subject_id: 's1' }] },
  ];
  assert.equal(firstObserved(history, 's1', '2026-08-22T00:00:00Z'), '2026-08-15T00:00:00Z');
});

// ---------------------------------------------------------------------------------------------
// End to end, against the bundled fixtures. This is the "clone and it runs" guarantee.
// ---------------------------------------------------------------------------------------------
test('the fixture pipeline runs end to end and withholds what it cannot establish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-'));
  try {
    const config = { ...loadConfig(), warehouse: { engine: 'duckdb', path: ':memory:' }, evidence: { path: dir } };
    const result = await runPipeline({ config, fixture: true, asOf: '2026-08-20T00:00:00Z', log: () => {} });

    assert.ok(result.assertions.length >= 5, 'the bundled fixtures should assert most controls');

    // The corporate IdP has no collector in the example config. It must be WITHHELD - asserting
    // 0 of 0 passing would be a vacuous pass, which is the worst thing this tool could emit.
    const withheld = result.withheld.map((w) => w.control_id);
    assert.ok(withheld.includes('ctl.iam.corp-it.mfa'), `expected corp-it withheld, got ${withheld}`);
    assert.ok(!result.assertions.some((a) => a.control_id === 'ctl.iam.corp-it.mfa'));

    for (const a of result.assertions) {
      assert.equal(a.fixture, true, `${a.control_id} must be stamped as fixture evidence`);
      assert.equal(a.passing_count + a.failing_count, a.total);
      assert.ok(a.total > 0, `${a.control_id} asserted over an empty population`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the never-screened supplier and the unresolved manufacturer are both caught', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-'));
  try {
    const config = { ...loadConfig(), warehouse: { engine: 'duckdb', path: ':memory:' }, evidence: { path: dir } };
    const result = await runPipeline({ config, fixture: true, asOf: '2026-08-20T00:00:00Z', log: () => {} });

    const screening = result.assertions.find((a) => a.control_id === 'ctl.scrm.procurement.entity-list-screening');
    const reasons = screening.failing.map((f) => f.reason);
    assert.ok(reasons.includes('never_screened'), 'a supplier with no screening date must fail');
    assert.ok(reasons.includes('listed_on_1260h'), 'a listed entity must be caught');
    assert.ok(reasons.includes('screened_against_superseded_list_edition'));

    const telecom = result.assertions.find(
      (a) => a.control_id === 'ctl.scrm.procurement.telecom-equipment-attestation'
    );
    assert.ok(telecom.failing.some((f) => f.reason === 'manufacturer_unresolved'));
    assert.ok(telecom.failing.some((f) => f.reason.startsWith('covered_manufacturer')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a correctly triaged non-reportable incident passes rather than failing for having no report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-'));
  try {
    const config = { ...loadConfig(), warehouse: { engine: 'duckdb', path: ':memory:' }, evidence: { path: dir } };
    const result = await runPipeline({ config, fixture: true, asOf: '2026-08-20T00:00:00Z', log: () => {} });
    const ir = result.assertions.find((a) => a.control_id === 'ctl.ir.dibnet.incident-reporting');

    // INC-2026-0402 is non-reportable with a recorded basis. Demanding a DIBNet submission for it
    // would make every correctly-triaged incident a failure.
    assert.ok(!ir.failing.some((f) => f.subject_id === 'INC-2026-0402'));
    assert.ok(ir.failing.some((f) => f.subject_id === 'INC-2026-0417'), 'the late report must fail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
