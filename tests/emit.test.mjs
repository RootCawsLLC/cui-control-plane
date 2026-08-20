import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAssertions, loadControls } from '../src/lib/load.mjs';
import { score, UnverifiedWeights } from '../src/sprs.mjs';
import { serialize } from '../src/oscal/common.mjs';
import { catalog, profiles } from '../src/oscal/catalog.mjs';
import { componentDefinition } from '../src/oscal/component-definition.mjs';
import { assessmentResults } from '../src/oscal/assessment-results.mjs';
import { poam, segmentDurations } from '../src/oscal/poam.mjs';
import { ssp } from '../src/oscal/ssp.mjs';

const assertions = loadAssertions('fixtures/assertions');

test('fixtures load and every one is marked as a fixture', () => {
  assert.equal(assertions.length, 6);
  for (const a of assertions) {
    assert.equal(a.fixture, true, `${a.control_id} must be stamped as a fixture`);
    assert.equal(a.passing_count + a.failing_count, a.total, `${a.control_id} counts must reconcile`);
    assert.equal(a.failing.length, a.failing_count, `${a.control_id} failing[] must be fully enumerated`);
  }
});

// ---------------------------------------------------------------------------------------------
// Byte-stability. This is the property the deterministic UUIDs exist to create, and it is worth a
// test rather than a claim in a README: an unchanged inventory must re-export identically, or the
// artifacts cannot live in Git meaningfully and the strongest published criticism of OSCAL lands.
// ---------------------------------------------------------------------------------------------
const emitters = {
  catalog: () => catalog(),
  'profile-cmmc-l2': () => profiles()[0].doc,
  'profile-scrm': () => profiles()[1].doc,
  'component-definition': () => componentDefinition(),
  'assessment-results': () => assessmentResults(assertions),
  poam: () => poam(assertions).doc,
  ssp: () => ssp(assertions),
};

for (const [name, emit] of Object.entries(emitters)) {
  test(`${name} re-exports byte-identically`, () => {
    assert.equal(serialize(emit()), serialize(emit()));
  });
}

test('no artifact carries a wall-clock timestamp', () => {
  // last-modified is derived from the newest as_of in the evidence, never from Date.now(). If it
  // were, every export would differ from the last and byte-stability would be meaningless.
  const newest = assertions.map((a) => a.as_of).sort().at(-1);
  for (const [name, emit] of Object.entries(emitters)) {
    const doc = emit();
    const root = Object.values(doc)[0];
    const lm = root.metadata['last-modified'];
    assert.ok(
      lm === newest || lm === '1970-01-01T00:00:00.000Z',
      `${name} last-modified is ${lm}, which is neither the evidence timestamp nor the epoch`
    );
  }
});

test('every UUID in the emitted set is v5', () => {
  const seen = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'uuid' || k.endsWith('-uuid')) seen.push(val);
        else walk(val);
      }
    }
  };
  for (const emit of Object.values(emitters)) walk(emit());
  assert.ok(seen.length > 20, 'expected the package to carry UUIDs');
  for (const u of seen) {
    assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, u);
  }
});

// ---------------------------------------------------------------------------------------------
// Fixture containment. A package built from synthetic evidence must say so everywhere it could be
// mistaken for real, because a fixture package that reads as real is the single most damaging
// artifact this repository could produce.
// ---------------------------------------------------------------------------------------------
test('fixture evidence stamps every artifact generated from it', () => {
  for (const name of ['assessment-results', 'poam', 'ssp']) {
    const doc = emitters[name]();
    const meta = Object.values(doc)[0].metadata;
    assert.match(meta.title, /NOT REAL EVIDENCE/, `${name} title`);
    assert.match(meta.remarks, /must not be submitted/, `${name} remarks`);
  }
});

// ---------------------------------------------------------------------------------------------
// The SSP is generated, never hand-authored.
// ---------------------------------------------------------------------------------------------
test('the SSP is a pure function of the control records and the evidence', () => {
  assert.equal(serialize(ssp(assertions)), serialize(ssp(assertions)));
});

test('every SSP statement restates its control record rather than new prose', () => {
  const doc = ssp(assertions)['system-security-plan'];
  const controls = new Map(loadControls().map((c) => [c.control_id, c]));
  const impls = doc['control-implementation']['implemented-requirements'];

  assert.ok(impls.length > 0);
  for (const impl of impls) {
    const control = controls.get(impl['control-id']);
    const prose = impl.statements[0]['by-components'][0].description;
    assert.ok(prose.includes(control.assertion.trim()), `${control.control_id} assertion missing`);
    assert.ok(prose.includes(control.population_definition.trim()), `${control.control_id} population missing`);
    assert.ok(prose.includes(control.owner), `${control.control_id} owner missing`);
  }
});

test('the SSP excludes out-of-boundary controls', () => {
  const doc = ssp(assertions)['system-security-plan'];
  const ids = doc['control-implementation']['implemented-requirements'].map((i) => i['control-id']);
  assert.ok(!ids.includes('ctl.iam.corp-it.mfa'));
  assert.ok(ids.includes('ctl.iam.cui-enclave.mfa'));
});

// ---------------------------------------------------------------------------------------------
// Assessment results must not round a partial pass up to satisfied.
// ---------------------------------------------------------------------------------------------
test('any failing item makes a finding not-satisfied, never rounded up', () => {
  const results = assessmentResults(assertions)['assessment-results'].results[0];
  for (const finding of results.findings) {
    const id = finding.target['target-id'];
    const a = assertions.find((x) => x.control_id === id);
    assert.equal(
      finding.target.status.state,
      a.failing_count === 0 ? 'satisfied' : 'not-satisfied',
      `${id} with ${a.failing_count} failing of ${a.total}`
    );
  }
  // The telecom control is 3 failing out of 1842 - the case most tempting to round up.
  const telecom = results.findings.find((f) => f.target['target-id'].includes('telecom'));
  assert.equal(telecom.target.status.state, 'not-satisfied');
});

test('an equals_detected basis is disclosed in the finding', () => {
  const results = assessmentResults(assertions)['assessment-results'].results[0];
  const corp = results.findings.find((f) => f.target['target-id'] === 'ctl.iam.corp-it.mfa');
  assert.match(corp.description, /systematically understated/);
});

// ---------------------------------------------------------------------------------------------
// POA&M
// ---------------------------------------------------------------------------------------------
test('the POA&M has one item per failing subject and carries the variance timestamps', () => {
  const { doc, warnings } = poam(assertions);
  const items = doc['plan-of-action-and-milestones']['poam-items'];
  const expected = assertions.reduce((n, a) => n + a.failing_count, 0);
  assert.equal(items.length, expected);

  const withTimestamps = items.filter((i) =>
    i.props.some((p) => p.name === 'variance-detected-at')
  );
  assert.equal(withTimestamps.length, expected, 'every item needs its variance timestamps');

  assert.ok(
    warnings.some((w) => w.includes('UNVERIFIED')),
    'an unverified non-POA&M-able list must warn rather than pass silently'
  );
});

test('variance segments decompose into the three FAIR-CAM windows', () => {
  const s = segmentDurations({
    variance_started_at: '2026-07-16T00:00:00Z',
    variance_detected_at: '2026-07-19T00:00:00Z',
    remediation_started_at: '2026-07-20T00:00:00Z',
    remediation_completed_at: '2026-07-22T00:00:00Z',
  });
  assert.equal(s['segment-monitoring-days'], 3);
  assert.equal(s['segment-prioritisation-days'], 1);
  assert.equal(s['segment-implementation-days'], 2);
});

test('a missing timestamp yields null rather than a fabricated zero', () => {
  const s = segmentDurations({ variance_detected_at: '2026-07-19T00:00:00Z' });
  assert.equal(s['segment-monitoring-days'], null);
  assert.equal(s['segment-implementation-days'], null);
});

// ---------------------------------------------------------------------------------------------
// SPRS
// ---------------------------------------------------------------------------------------------
test('the scorer refuses to run against unpopulated weights', () => {
  assert.throws(
    () => score({ assertions, weightsPath: 'reference/sprs-weights.yaml' }),
    UnverifiedWeights
  );
});

test('the scorer runs against fixture weights but never calls the result submittable', () => {
  const s = score({ assertions, weightsPath: 'fixtures/sprs-weights.fixture.yaml' });
  assert.equal(s.basis, 110);
  assert.equal(s.weights_verified, false);
  assert.equal(s.evidence_is_fixture, true);
  assert.equal(s.submittable, false);
  assert.equal(s.score, s.basis - s.deduction);
});

test('a requirement claimed only at low confidence is not scored as met', () => {
  const s = score({ assertions, weightsPath: 'fixtures/sprs-weights.fixture.yaml' });
  const r = s.results.find((x) => x.id === '3.11.1');
  assert.equal(r.met, false);
  assert.equal(r.basis, 'no_control_claims_this_requirement');
});

test('a requirement is met only when every claiming control passes', () => {
  const clean = assertions.map((a) => ({ ...a, failing: [], failing_count: 0, passing_count: a.total }));
  const s = score({ assertions: clean, weightsPath: 'fixtures/sprs-weights.fixture.yaml' });
  assert.equal(s.results.find((x) => x.id === '3.5.3').met, true);
  // 3.6.1 and 3.6.2 are both claimed by the single IR control, so both flip together.
  assert.equal(s.results.find((x) => x.id === '3.6.2').met, true);
  assert.ok(s.score > score({ assertions, weightsPath: 'fixtures/sprs-weights.fixture.yaml' }).score);
});
