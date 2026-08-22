import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scaleControls, scaleAssertions, EXPECTED_CONTROLS } from './helpers/scale-fixture.mjs';
import { uuid5 } from '../src/lib/uuid5.mjs';
import { UUID_NS } from '../src/lib/ns.mjs';
import { variance } from '../src/variance.mjs';
import { loadControls } from '../src/lib/load.mjs';

const controls = scaleControls();
const assertions = scaleAssertions();

test('the fixture covers every one of the 110 requirements', () => {
  assert.equal(controls.length, EXPECTED_CONTROLS);
  const refs = new Set(controls.flatMap((c) => c.crosswalk.map((x) => x.reference)));
  assert.equal(refs.size, 110);
});

test('the synthetic inventory is QUARANTINED from the real one', () => {
  // The whole point: populating controls/ with stubs would make `ccp coverage` report a number
  // describing nothing. The real loader must never see these.
  const real = loadControls().map((c) => c.control_id);
  for (const c of controls) {
    assert.ok(!real.includes(c.control_id), `${c.control_id} leaked into the real inventory`);
  }
  assert.ok(real.length < 20, `real inventory should still be small, got ${real.length}`);
});

test('every synthetic id is visibly synthetic', () => {
  // If one of these ever escapes into an artifact, it must be obvious on sight rather than needing
  // provenance archaeology.
  for (const c of controls) {
    assert.match(c.control_id, /\.synthetic\./);
    assert.match(c.title, /^SYNTHETIC/);
  }
  for (const a of assertions) {
    assert.equal(a.fixture, true);
    assert.match(a.coverage_basis, /NOT REAL EVIDENCE/);
  }
});

// ---------------------------------------------------------------------------------------------
// The three things that only break at scale.
// ---------------------------------------------------------------------------------------------

test('v5 UUIDs do not collide across 110 controls', () => {
  // "Should never collide" over a fixed namespace is a claim worth actually checking rather than
  // trusting, because a collision would silently merge two components in every OSCAL artifact.
  const ids = controls.map((c) => uuid5(UUID_NS, c.control_id));
  assert.equal(new Set(ids).size, controls.length);
});

test('v5 UUIDs do not collide across control x framework x requirement', () => {
  // The implemented-requirement key is the denser space, and the one most likely to collide.
  const keys = controls.flatMap((c) =>
    c.crosswalk.map((x) => uuid5(UUID_NS, `${c.control_id}|${x.framework}|${x.reference}`))
  );
  assert.equal(new Set(keys).size, keys.length, 'implemented-requirement UUID collision');
});

test('UUID derivation is stable across runs at scale', () => {
  const once = controls.map((c) => uuid5(UUID_NS, c.control_id));
  const twice = controls.map((c) => uuid5(UUID_NS, c.control_id));
  assert.deepEqual(once, twice);
});

test('variance handles 110 controls without quadratic blowup', () => {
  // Three snapshots each, so the history walk is exercised rather than short-circuited.
  const history = ['2026-08-19', '2026-08-20', '2026-08-21'].flatMap((d) =>
    scaleAssertions({ asOf: `${d}T00:00:00Z` })
  );

  const started = process.hrtime.bigint();
  const result = variance(history);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.rows.length, EXPECTED_CONTROLS);
  // Generous - this is a smoke test for accidental O(n^2), not a benchmark. A quadratic walk over
  // 330 assertions would blow well past this.
  assert.ok(ms < 4000, `variance over 330 assertions took ${Math.round(ms)}ms`);
});

test('assertion counts reconcile across the whole synthetic set', () => {
  for (const a of assertions) {
    assert.equal(a.passing_count + a.failing_count, a.total, a.control_id);
    assert.equal(a.failing.length, a.failing_count, a.control_id);
  }
});

test('the fixture is deterministic - no clock, no randomness', () => {
  const a = JSON.stringify(scaleAssertions());
  const b = JSON.stringify(scaleAssertions());
  assert.equal(a, b, 'a fixture that varies between runs cannot pin a regression');
});
