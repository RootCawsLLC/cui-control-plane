import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grade, collect, MFA_UNOBTAINABLE } from '../src/collectors/aws-identity-center.mjs';
import { selectCollectors } from '../src/collectors/registry.mjs';
import { TABLES } from '../src/collectors/tables.mjs';
import { buildAssertion } from '../src/pipeline.mjs';

const AT = '2026-08-21T00:00:00Z';

const USERS = [
  { UserId: 'u1', UserName: 'asmith', Active: null },
  { UserId: 'u2', UserName: 'bjones', Active: null },
  { UserId: 'u3', UserName: 'cdavis', Active: false },
];

const rows = (config = { identity: {} }) => grade({ users: USERS, config, collectedAt: AT });

// ---------------------------------------------------------------------------------------------
// The whole reason this collector is separate from aws-iam-identities.
// ---------------------------------------------------------------------------------------------
test('factor_count is null, never zero', () => {
  // Emitting 0 would assert "no MFA enrolled" when the truth is "not knowable from here", and the
  // resulting finding would be indistinguishable from a real one in the POA&M.
  for (const r of rows()) {
    assert.equal(r.factor_count, null, `${r.login} must not claim a known factor count`);
    assert.notEqual(r.factor_count, 0);
    assert.equal(r.strongest_factor_type, null);
  }
});

test('a null Active attribute is not a disabled user', () => {
  // ListUsers returns Active: null for stores that do not manage the attribute. Reading that as
  // disabled would silently shrink the workforce denominator.
  assert.equal(rows().find((r) => r.login === 'asmith').status, 'active');
  assert.equal(rows().find((r) => r.login === 'cdavis').status, 'disabled');
});

test('break-glass is group membership, since Identity Center has no user attributes', () => {
  const graded = grade({
    users: USERS,
    membershipsByUser: { u2: ['BreakGlass'] },
    config: { identity: { break_glass_group: 'BreakGlass' } },
    collectedAt: AT,
  });
  assert.equal(graded.find((r) => r.login === 'bjones').is_break_glass, true);
  assert.equal(graded.find((r) => r.login === 'asmith').is_break_glass, false);
});

// ---------------------------------------------------------------------------------------------
// Established population, unobtainable attribute. These are different things.
// ---------------------------------------------------------------------------------------------
test('the population is reported but marked insufficient for this control', async () => {
  const r = await collect({ config: { identity: {} }, collectedAt: AT, fixture: true });
  assert.ok(r.rows.length > 0, 'the workforce IS established');
  assert.equal(r.population.complete, false, 'but not sufficient for the MFA control');
  assert.notEqual(r.unavailable, true, 'this is not a failed read - the population is real');
});

test('the reason names both real ways to close the gap', async () => {
  const r = await collect({ config: { identity: {} }, collectedAt: AT, fixture: true });
  // A withheld control that does not say what to do next is a dead end.
  assert.match(r.population.reconciliation, /entra \| okta/);
  assert.match(r.population.reconciliation, /manual attestation/);
  assert.match(MFA_UNOBTAINABLE, /UNKNOWN rather than absent/);
});

test('an incomplete population never produces passing members', () => {
  // Belt and braces: even if this population reached the assertion layer, null factor_count must
  // not pass. `passing !== true` is what enforces it.
  const control = {
    control_id: 'ctl.iam.cui-enclave.mfa',
    population_definition: 'workforce',
    source_system: 'identity-center',
    query_ref: 'models/controls/ctl_iam_cui_enclave_mfa.sql',
  };
  const a = buildAssertion({
    control,
    rows: [{ subject_id: 'u1', passing: null, reason: 'unknown' }],
    asOf: AT,
    fixture: true,
  });
  assert.equal(a.passing_count, 0);
  assert.equal(a.failing_count, 1);
});

test('a collector that ran is never reported as absent', async () => {
  // Two different facts: "no collector populated X" and "a collector ran but could not establish
  // enough". Emitting both makes the second contradict the first and sends the analyst looking for
  // a collector that already exists.
  const { runPipeline } = await import('../src/pipeline.mjs');
  const { loadConfig, EXAMPLE_CONFIG } = await import('../src/config.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'ccp-idc-'));
  try {
    const base = loadConfig(EXAMPLE_CONFIG);
    const config = {
      ...base,
      identity: { provider: 'aws-identity-center' },
      warehouse: { engine: 'duckdb', path: ':memory:' },
      evidence: { path: dir },
    };
    const result = await runPipeline({ config, fixture: true, asOf: AT, log: () => {} });
    const mfa = result.withheld.find((w) => w.control_id === 'ctl.iam.cui-enclave.mfa');
    assert.ok(mfa, 'the MFA control must still be withheld');
    assert.ok(
      !mfa.reasons.some((r) => /no collector populated/.test(r)),
      'a collector DID run, so it must not be reported as absent: ' + JSON.stringify(mfa.reasons)
    );
    assert.ok(mfa.reasons.some((r) => /no per-user MFA enrolment/.test(r)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identity-center is selectable and lands on the enclave IdP table', () => {
  const { chosen } = selectCollectors({
    identity: { provider: 'aws-identity-center' },
    cloud: { provider: 'none' },
    procurement: {},
    inventory: {},
    incident_response: {},
    reference: {},
  });
  const c = chosen.find((x) => x.name === 'aws-identity-center');
  assert.ok(c, 'must be selectable');
  assert.ok(TABLES[c.table], `unknown table ${c.table}`);
  assert.ok(c.controls.includes('ctl.iam.cui-enclave.mfa'));
});

test('aws-iam and aws-identity-center are different providers for different populations', () => {
  // The distinction this collector exists for: in a federated account the IAM users are service
  // principals, and the humans are in the Identity Store.
  const pick = (provider) =>
    selectCollectors({
      identity: { provider },
      cloud: { provider: 'none' },
      procurement: {},
      inventory: {},
      incident_response: {},
      reference: {},
    }).chosen.find((c) => c.controls.includes('ctl.iam.cui-enclave.mfa'));

  assert.equal(pick('aws-iam').name, 'aws-iam-identities');
  assert.equal(pick('aws-identity-center').name, 'aws-identity-center');
  // Same landing table, so the control stays provider-agnostic.
  assert.equal(pick('aws-iam').table, pick('aws-identity-center').table);
});
