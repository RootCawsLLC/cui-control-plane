import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  grade,
  parseCredentialReport,
  reconciliation,
  collect,
} from '../src/collectors/aws-iam-identities.mjs';
import { selectCollectors } from '../src/collectors/registry.mjs';
import { TABLES } from '../src/collectors/tables.mjs';

const AT = '2026-08-21T00:00:00Z';

const REPORT = parseCredentialReport(
  [
    'user,arn,user_creation_time,password_enabled,password_last_changed,mfa_active,access_key_1_active,access_key_2_active',
    '<root_account>,arn:aws:iam::1:root,2025-01-04T00:00:00+00:00,not_supported,not_supported,true,false,false',
    'alice,arn:aws:iam::1:user/alice,2025-02-11T00:00:00+00:00,true,2026-06-01T00:00:00+00:00,true,false,false',
    'bob,arn:aws:iam::1:user/bob,2025-03-02T00:00:00+00:00,true,2026-05-14T00:00:00+00:00,false,true,false',
    'ci-deploy,arn:aws:iam::1:user/ci-deploy,2025-04-19T00:00:00+00:00,false,N/A,false,true,false',
  ].join('\n')
);

const rows = (config = { identity: {} }) => grade({ report: REPORT, config, collectedAt: AT });

// ---------------------------------------------------------------------------------------------
// Population boundaries. Each of these, got wrong, moves the denominator without anyone noticing.
// ---------------------------------------------------------------------------------------------
test('the root account is never a workforce identity', () => {
  // It cannot be remediated the way a user can, so including it puts a permanent failure in a
  // queue people are meant to work.
  assert.ok(!rows().some((r) => r.login === '<root_account>'));
});

test('a key-only principal is excluded by default - it has no console to phish', () => {
  assert.ok(!rows().some((r) => r.login === 'ci-deploy'));
});

test('include_console_disabled brings automation principals back in, deliberately', () => {
  const withAll = rows({ identity: { include_console_disabled: true } });
  assert.ok(withAll.some((r) => r.login === 'ci-deploy'));
  assert.equal(withAll.length, 3);
});

test('exclusions are disclosed, not silent', () => {
  const r = reconciliation(REPORT, rows());
  assert.match(r, /root account excluded/);
  assert.match(r, /1 principal\(s\) excluded as having no console password/);
});

test('fixture and live paths disclose exclusions identically', async () => {
  // A fixture run that hides the reconciliation teaches a different disclosure shape than
  // production produces, and the fixture is what people read first.
  const r = await collect({ config: { identity: {} }, collectedAt: AT, fixture: true });
  assert.match(r.population.reconciliation, /root account excluded/);
  assert.ok(r.population.expected > r.population.examined, 'exclusions must show in the counts');
});

// ---------------------------------------------------------------------------------------------
// What counts as a factor. This is where a flattering number would come from.
// ---------------------------------------------------------------------------------------------
test('an access key is not a factor', () => {
  // bob holds an active key and no MFA device. Counting the key as authentication strength is how
  // a population of key-holding principals reports as authenticated.
  const bob = rows().find((r) => r.login === 'bob');
  assert.equal(bob.factor_count, 0);
  assert.equal(bob.strongest_factor_type, null);
  assert.equal(bob.active_access_keys, 1, 'the key is still carried, so a reviewer sees it');
});

test('IAM MFA never claims to be phishing-resistant', () => {
  // The credential report cannot distinguish TOTP from a hardware key. Emitting `webauthn` would
  // assert a property the data does not support, and the model would pass it.
  const alice = rows().find((r) => r.login === 'alice');
  assert.equal(alice.factor_count, 1);
  assert.notEqual(alice.strongest_factor_type, 'webauthn');
  assert.notEqual(alice.strongest_factor_type, 'piv_cac');
  assert.equal(alice.strongest_factor_type, 'totp_or_hardware');
});

test('every row lands on a real landing table and a real control', () => {
  const { chosen } = selectCollectors({
    identity: { provider: 'aws-iam' },
    cloud: { provider: 'none' },
    procurement: {},
    inventory: {},
    incident_response: {},
    reference: {},
  });
  const c = chosen.find((x) => x.name === 'aws-iam-identities');
  assert.ok(c, 'aws-iam must be selectable as an identity provider');
  assert.ok(TABLES[c.table], `unknown table ${c.table}`);
  assert.ok(c.controls.includes('ctl.iam.cui-enclave.mfa'));
});

test('a missing SDK is an unknown population, not an empty one', async () => {
  // @aws-sdk/client-iam is an optional dependency and may not be installed.
  const r = await collect({ config: { identity: {}, cloud: {} }, collectedAt: AT, fixture: false });
  if (r.unavailable) {
    assert.equal(r.population.complete, false);
    assert.equal(r.rows.length, 0);
  }
});
