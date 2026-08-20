import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { repoPath, DEFAULT_PHISHING_RESISTANT, DEFAULT_PHISHING_RESISTANT_OKTA } from '../src/config.mjs';
import { grade as gradeOkta, normaliseFactor, parseNextLink } from '../src/collectors/okta-identities.mjs';
import { grade as gradeAws, readTag, collect as collectAws, QUERY } from '../src/collectors/aws-assets.mjs';
import { selectCollectors } from '../src/collectors/registry.mjs';

const AT = '2026-08-20T00:00:00Z';
const fixture = (name) => JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${name}.json`), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Okta. Three traps, each of which silently corrupts a population rather than erroring.
// ---------------------------------------------------------------------------------------------
test('okta pagination is a Link header, not a body cursor', () => {
  const header =
    '<https://acme.okta.com/api/v1/users?after=aaa&limit=200>; rel="next", ' +
    '<https://acme.okta.com/api/v1/users?limit=200>; rel="self"';
  assert.equal(parseNextLink(header), 'https://acme.okta.com/api/v1/users?after=aaa&limit=200');
  // No next link means the population is complete, not that something went wrong.
  assert.equal(parseNextLink('<https://acme.okta.com/api/v1/users>; rel="self"'), null);
  assert.equal(parseNextLink(null), null);
});

test('a PENDING_ACTIVATION factor is not coverage', () => {
  // This is how an MFA rollout reports full coverage while part of the population still signs in
  // with a password: the enrolment exists, it was never activated, and nobody filtered on status.
  const rows = gradeOkta({
    ...fixture('okta-identities'),
    config: { identity: {} },
    collectedAt: AT,
  });
  const frank = rows.find((r) => r.login === 'frank@example.mil');
  assert.equal(frank.factor_count, 1, 'only the ACTIVE sms factor counts');
  assert.notEqual(frank.strongest_factor_type, 'webauthn', 'the pending webauthn must not count');
});

test('okta factor names map onto the vocabulary the model tests', () => {
  const resistant = new Set(DEFAULT_PHISHING_RESISTANT_OKTA);
  assert.equal(normaliseFactor('webauthn', resistant), 'webauthn');
  assert.equal(normaliseFactor('u2f', resistant), 'webauthn');
  assert.equal(normaliseFactor('sms', resistant), 'sms');

  // piv_cac is never INFERRED. Smart-card is an external IdP in Okta rather than a factor, so it
  // only maps to the passing token where the organisation has declared it acceptable - emitting
  // piv_cac off the raw name alone would manufacture a stronger claim than the data supports.
  assert.equal(normaliseFactor('x509', resistant), 'x509');
  assert.equal(normaliseFactor('x509', new Set([...resistant, 'x509'])), 'piv_cac');
});

test('an unaccepted factor cannot pass on its raw name alone', () => {
  // Okta's raw factorType for a security key IS 'webauthn', which is also the token the control
  // model treats as passing. An org that has not accepted it must not have it counted anyway.
  const withoutWebauthn = new Set(['u2f']);
  assert.notEqual(normaliseFactor('webauthn', withoutWebauthn), 'webauthn');
  assert.match(normaliseFactor('webauthn', withoutWebauthn), /not-accepted/);
});

test('okta defaults differ from entra defaults, and using the wrong set would fail everyone', () => {
  assert.notDeepEqual(DEFAULT_PHISHING_RESISTANT_OKTA, DEFAULT_PHISHING_RESISTANT);
  // Grading Okta data with Entra's vocabulary marks a genuine webauthn key as not resistant.
  const withEntraNames = gradeOkta({
    ...fixture('okta-identities'),
    config: { identity: { phishing_resistant_methods: DEFAULT_PHISHING_RESISTANT } },
    collectedAt: AT,
  });
  const alice = withEntraNames.find((r) => r.login === 'alice@example.mil');
  assert.notEqual(alice.strongest_factor_type, 'webauthn');
});

test('okta statuses collapse to active/disabled, and only ACTIVE can sign in', () => {
  const rows = gradeOkta({ ...fixture('okta-identities'), config: { identity: {} }, collectedAt: AT });
  assert.equal(rows.find((r) => r.login === 'judy@example.mil').status, 'disabled');
  assert.equal(rows.find((r) => r.login === 'alice@example.mil').status, 'active');
});

test('okta break-glass is read from a profile attribute, never a name pattern', () => {
  const rows = gradeOkta({
    ...fixture('okta-identities'),
    config: { identity: { break_glass_attribute: 'extensionAttribute1', break_glass_value: 'break-glass' } },
    collectedAt: AT,
  });
  assert.equal(rows.find((r) => r.login === 'breakglass1@example.mil').is_break_glass, true);
  assert.equal(rows.find((r) => r.login === 'alice@example.mil').is_break_glass, false);
});

// ---------------------------------------------------------------------------------------------
// AWS. The tag-shape trap is the one that turns correct tagging into false findings.
// ---------------------------------------------------------------------------------------------
test('all three AWS Config tag shapes are read', () => {
  assert.equal(readTag([{ key: 'owner', value: 'platform' }], 'owner'), 'platform');
  assert.equal(readTag({ owner: 'platform' }, 'owner'), 'platform');
  assert.equal(readTag(['owner=platform'], 'owner'), 'platform');
  assert.equal(readTag([], 'owner'), null);
  assert.equal(readTag(null, 'owner'), null);
});

test('an untagged resource yields null, which the inventory control fails on', () => {
  const rows = gradeAws({ results: fixture('aws-assets').results, collectedAt: AT });
  const untagged = rows.find((r) => r.resource_id === 'db-enclave-reporting-02');
  assert.equal(untagged.owner_tag, null);
  assert.equal(untagged.data_classification_tag, null);

  const partial = rows.find((r) => r.resource_id === 'enclave-scratch-0042');
  assert.equal(partial.owner_tag, 'platform-team');
  assert.equal(partial.data_classification_tag, null, 'missing classification must not be invented');
});

test('every tag shape in the fixture resolves to the same owner', () => {
  const rows = gradeAws({ results: fixture('aws-assets').results, collectedAt: AT });
  const owners = rows.filter((r) => r.owner_tag).map((r) => r.owner_tag);
  assert.equal(owners.length, 4);
  assert.ok(owners.every((o) => o === 'platform-team'));
});

test('the Config query does not restrict to taggable resources', () => {
  // The Tagging API would be easier and would silently omit untaggable resources - holes in the
  // denominator every other CUI-scoped control depends on.
  assert.match(QUERY, /resourceType LIKE 'AWS::%'/);
});

test('a missing region is refused rather than defaulted to a commercial one', async () => {
  // A commercial region against GovCloud does not error, it returns a confidently empty result -
  // the exact shape of a silent false pass.
  const r = await collectAws({ config: { cloud: { provider: 'aws-govcloud' } }, collectedAt: AT });
  assert.equal(r.unavailable, true);
  assert.equal(r.population.complete, false);
  assert.match(r.population.reconciliation, /us-gov-west-1/);
  assert.equal(r.rows.length, 0);
});

test('a missing AWS SDK is an unavailable population, not a crash and not an empty one', async () => {
  const r = await collectAws({
    config: { cloud: { provider: 'aws-govcloud', region: 'us-gov-west-1' } },
    collectedAt: AT,
  });
  // The SDK is an optional dependency and is not installed here, which is the point of the test.
  assert.equal(r.unavailable, true);
  assert.equal(r.population.complete, false);
  assert.match(r.population.reconciliation, /@aws-sdk\/client-config-service/);
});

// ---------------------------------------------------------------------------------------------
// Registry: both providers are now real choices rather than documented intentions.
// ---------------------------------------------------------------------------------------------
const base = { procurement: {}, inventory: {}, incident_response: {}, reference: {} };

test('okta and aws-govcloud now select real collectors', () => {
  const { chosen } = selectCollectors({
    ...base,
    identity: { provider: 'okta' },
    cloud: { provider: 'aws-govcloud' },
  });
  assert.ok(chosen.some((c) => c.name === 'okta-identities'));
  assert.ok(chosen.some((c) => c.name === 'aws-assets'));
});

test('each identity provider lands on the same table, so the control is provider-agnostic', () => {
  const forProvider = (provider) =>
    selectCollectors({ ...base, identity: { provider }, cloud: { provider: 'none' } }).chosen.find((c) =>
      c.controls.includes('ctl.iam.cui-enclave.mfa')
    );
  const tables = ['entra', 'okta', 'csv'].map((p) => forProvider(p).table);
  assert.deepEqual(new Set(tables), new Set(['src_enclave_idp_users_snapshot']));
});

test('each cloud provider lands assets on a provider-neutral table', () => {
  const azure = selectCollectors({ ...base, identity: { provider: 'none' }, cloud: { provider: 'azure-gov' } });
  const aws = selectCollectors({ ...base, identity: { provider: 'none' }, cloud: { provider: 'aws-govcloud' } });
  assert.equal(azure.chosen.find((c) => c.name === 'azure-assets').table, 'src_cloud_resources');
  assert.equal(aws.chosen.find((c) => c.name === 'aws-assets').table, 'src_cloud_resources');
});
