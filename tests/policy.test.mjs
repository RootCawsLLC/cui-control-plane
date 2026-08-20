import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAssertions, loadControls } from '../src/lib/load.mjs';
import { policy, formatPolicy } from '../src/policy.mjs';
import { representation889, formatRepresentation, CONTROL_ID } from '../src/representation.mjs';

const assertions = loadAssertions('fixtures/assertions');

// ---------------------------------------------------------------------------------------------
// Policy last. Nothing in the inventory is operating yet, so the correct output is nothing.
// ---------------------------------------------------------------------------------------------
test('no operating control means no policy, and that is the correct result', () => {
  const r = policy({ assertions });
  assert.deepEqual(r.documents, []);
  assert.equal(r.skipped.length, loadControls().length);
  assert.match(formatPolicy(r), /that is the correct result/);
});

test('every skipped control is named with its status rather than silently dropped', () => {
  const text = formatPolicy(policy({ assertions }));
  for (const c of loadControls()) {
    assert.ok(text.includes(c.control_id), `${c.control_id} must be named as not eligible`);
  }
});

test('an operating control generates policy derived entirely from its record', () => {
  const control = { ...loadControls().find((c) => c.control_id === 'ctl.iam.cui-enclave.mfa'), status: 'operating' };
  const r = policy({ assertions, controls: [control], exceptions: [] });

  assert.equal(r.documents.length, 1);
  assert.equal(r.documents[0].filename, 'policy-iam.md');

  const body = r.documents[0].body;
  // Scope, requirement, owner and verification all come from the control record - nothing is
  // authored in the generator.
  assert.ok(body.includes(control.assertion.trim()), 'requirement is the assertion');
  assert.ok(body.includes(control.population_definition.trim()), 'scope is the population');
  assert.ok(body.includes(control.owner), 'owner');
  assert.ok(body.includes(control.query_ref), 'how it is verified');
  assert.match(body, /Do not hand edit/);
});

test('an approved exception appears in policy with its expiry, not as a pass', () => {
  const control = { ...loadControls().find((c) => c.control_id === 'ctl.iam.cui-enclave.mfa'), status: 'operating' };
  const exception = {
    exception_id: 'EX-0041',
    control_id: control.control_id,
    subjects: ['u_a', 'u_b'],
    reason: 'Break-glass accounts.',
    approved_by: 'security-engineering',
    granted_at: '2026-06-01',
    expires_at: '2026-12-31',
    compensating: ['Session recording'],
  };
  const body = policy({ assertions, controls: [control], exceptions: [exception] }).documents[0].body;

  assert.match(body, /EX-0041/);
  assert.match(body, /expires 2026-12-31/);
  assert.match(body, /reduces coverage; it is not a pass/);
  assert.match(body, /Session recording/);
});

test('a control whose status is not operating never reaches the document', () => {
  const controls = loadControls().map((c) => ({ ...c, status: 'building' }));
  assert.deepEqual(policy({ assertions, controls, exceptions: [] }).documents, []);
});

// ---------------------------------------------------------------------------------------------
// Section 889 - the representation is a projection of the control, and refuses when the control
// cannot support it.
// ---------------------------------------------------------------------------------------------
test('unresolved manufacturers block the affirmative representation', () => {
  const r = representation889({ assertions });
  assert.equal(r.state, 'blocked');
  assert.equal(r.blockers.length, 3);
  assert.ok(r.blockers.every((b) => b.reason === 'manufacturer_unresolved'));

  const text = formatRepresentation(r);
  assert.match(text, /REFUSING/);
  assert.match(text, /representing nothing yet/);
  // Every blocking subject is named - a count alone is not actionable.
  for (const b of r.blockers) assert.ok(text.includes(b.subject_id));
});

test('a clean population produces a draft, and still leaves the legal act to a person', () => {
  const clean = assertions.map((a) =>
    a.control_id === CONTROL_ID
      ? { ...a, failing: [], failing_count: 0, passing_count: a.total }
      : a
  );
  const r = representation889({ assertions: clean });
  assert.equal(r.state, 'affirmative');
  assert.match(r.body, /Draft representation/);
  assert.match(r.body, /remains a draft for the responsible official/);
  assert.match(r.body, /NOT REAL EVIDENCE/, 'fixture evidence must stamp the representation too');
});

test('the representation carries the population and the query, not just a conclusion', () => {
  const r = representation889({ assertions });
  assert.ok(r.body.includes(r.assertion.query_ref));
  assert.ok(r.body.includes(r.assertion.population_definition.trim()));
  assert.ok(r.body.includes(r.assertion.as_of));
});

test('no assertion means no representation - that is the form-signing process it replaces', () => {
  const r = representation889({ assertions: [] });
  assert.equal(r.state, 'no-evidence');
  assert.equal(r.body, null);
  assert.match(formatRepresentation(r), /form-signing process this control replaces/);
});
