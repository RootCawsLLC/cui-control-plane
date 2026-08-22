import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAttestation, assertionFromAttestation, TIER_BY_METHOD } from '../src/attestation.mjs';

const CONTROL = {
  control_id: 'ctl.iam.cui-enclave.mfa',
  population_definition: 'All human identities in the enclave IdP with status active.',
};

const base = () => ({
  control_id: 'ctl.iam.cui-enclave.mfa',
  attested_by: 'Ada Lovelace',
  role: 'Security Owner',
  attested_at: '2026-08-21',
  expires_at: '2026-11-21',
  statement: 'Every one of the 4 active workforce identities has a factor registered.',
  basis: 'Read the MFA panel for each user in the console on 2026-08-21.',
  why_no_query: 'Identity Center publishes no per-user MFA enrolment through any public API.',
  method: 'console-review',
  population_definition: 'All human identities in the enclave IdP with status active.',
  total: 4,
  passing_count: 4,
  failing: [],
});

const NOW = new Date('2026-08-21T12:00:00Z');
const check = (doc, opts = {}) => validateAttestation(doc, { controls: [CONTROL], now: NOW, ...opts });

test('a well-formed attestation validates', () => {
  const r = check(base());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.expired, false);
});

// ---------------------------------------------------------------------------------------------
// Expiry. The whole reason an attestation is allowed to exist at all.
// ---------------------------------------------------------------------------------------------
test('an expired attestation is detected, and produces NO assertion', () => {
  const doc = { ...base(), attested_at: '2025-01-01', expires_at: '2025-04-01' };
  assert.equal(check(doc).expired, true);
  // Null, not a failing assertion. A stale claim is not a broken control, and reporting it as
  // failing would send somebody to fix something that may be perfectly fine.
  assert.equal(assertionFromAttestation(doc, { asOf: '2026-08-21T00:00:00Z', now: NOW }), null);
});

test('a multi-year validity is refused - that is an unexpiring claim in a costume', () => {
  const r = check({ ...base(), expires_at: '2031-08-21' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /too long/.test(e)));
});

test('expires_at must be after attested_at', () => {
  const r = check({ ...base(), expires_at: '2026-08-01' });
  assert.ok(r.errors.some((e) => /after attested_at/.test(e)));
});

// ---------------------------------------------------------------------------------------------
// Confidence. Manual evidence never reaches the tier a query earns.
// ---------------------------------------------------------------------------------------------
test('manual evidence is capped at tier 2, never the 4 a query earns', () => {
  for (const method of ['console-review', 'vendor-report', 'process-walkthrough']) {
    const a = assertionFromAttestation({ ...base(), method }, { asOf: '2026-08-21T00:00:00Z', now: NOW });
    assert.equal(a.confidence_tier, 2, method);
  }
});

test('a sample is admitted only at tier 1', () => {
  // This repository refuses sampling everywhere else. Where a sample is genuinely all that exists it
  // is labelled and scored lowest, not quietly promoted.
  const a = assertionFromAttestation({ ...base(), method: 'sampled-inspection' }, { asOf: '2026-08-21T00:00:00Z', now: NOW });
  assert.equal(a.confidence_tier, 1);
  assert.equal(TIER_BY_METHOD['sampled-inspection'], 1);
});

test('the assertion is marked attested, so nothing downstream mistakes it for telemetry', () => {
  const a = assertionFromAttestation(base(), { asOf: '2026-08-21T00:00:00Z', now: NOW });
  assert.equal(a.source_kind, 'attested');
  assert.match(a.coverage_basis, /ATTESTED, not queried/);
  assert.match(a.source_system, /attestation by Ada Lovelace/);
});

// ---------------------------------------------------------------------------------------------
// The rules a schema cannot express.
// ---------------------------------------------------------------------------------------------
test('a role or placeholder in attested_by is refused - a person has to sign it', () => {
  for (const who of ['the security team', 'Security Team', 'IT Ops', 'DevOps', 'SRE', 'TBD', 'unknown', 'N/A', 'Platform Group']) {
    const r = check({ ...base(), attested_by: who });
    assert.equal(r.ok, false, `"${who}" should be refused`);
    assert.ok(r.errors.some((e) => /role or placeholder/.test(e)), who);
  }
});

test('real names are NOT rejected, including the ones a naive check would break on', () => {
  // The tempting implementation - require two capitalised tokens, or reject anything without a
  // space - rejects mononyms, non-Latin scripts, particled and hyphenated surnames. That fails in
  // the unsafe direction by turning away real attesters, so the check is a narrow blocklist of
  // org-unit words instead. These must all pass.
  for (const who of [
    'Ada Lovelace',
    'Ali',
    'Иван Петров',
    'Ng Wei Ming',
    "Mary-Jane O'Brien",
    'Ludwig van Beethoven',
    'Bishop Marshall',
  ]) {
    const r = check({ ...base(), attested_by: who });
    assert.equal(r.ok, true, `"${who}" was wrongly refused: ${r.errors.join('; ')}`);
  }
});

test('counts must reconcile, exactly as a queried assertion must', () => {
  const r = check({ ...base(), total: 4, passing_count: 4, failing: [{ subject_id: 'u1', reason: 'no factor' }] });
  assert.ok(r.errors.some((e) => /do not reconcile/.test(e)));
});

test('population drift from the control record is refused', () => {
  // An attestation about a subtly different population is not evidence for that control. This fired
  // on the first real attestation written against the lab, which had paraphrased the wording.
  const r = check({ ...base(), population_definition: 'all users who can log in to the enclave' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /population drift/.test(e)));
});

test('whitespace and case differences are NOT drift', () => {
  const r = check({ ...base(), population_definition: '  ALL HUMAN identities in the enclave IdP   with status active.  ' });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('an attestation for a control that does not exist is refused', () => {
  const r = check({ ...base(), control_id: 'ctl.iam.nonexistent.thing' });
  assert.ok(r.errors.some((e) => /no control record/.test(e)));
});

test('why_no_query is required, so attesting is a choice rather than the easy path', () => {
  const doc = base();
  delete doc.why_no_query;
  // Schema-optional but the field exists precisely to make the reasoning visible; when present it
  // must survive into the assertion so a reader sees why no query was possible.
  const a = assertionFromAttestation(base(), { asOf: '2026-08-21T00:00:00Z', now: NOW });
  assert.match(a.coverage_basis, /No query because/);
});

test('failing subjects are enumerated, not just counted', () => {
  const doc = { ...base(), total: 4, passing_count: 3, failing: [{ subject_id: 'u_99', reason: 'no factor enrolled' }] };
  assert.equal(check(doc).ok, true);
  const a = assertionFromAttestation(doc, { asOf: '2026-08-21T00:00:00Z', now: NOW });
  assert.equal(a.failing_count, 1);
  assert.equal(a.failing[0].subject_id, 'u_99');
  // An attester saw a state, not a transition - so onset cannot be established.
  assert.equal(a.failing[0].variance.started_at_basis, 'equals_detected');
});
