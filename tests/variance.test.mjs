import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAssertions } from '../src/lib/load.mjs';
import {
  variance,
  varianceEpisodes,
  formatVariance,
  SATURATION_THRESHOLD,
  MIN_WINDOW_DAYS,
} from '../src/variance.mjs';

const assertions = loadAssertions('fixtures/assertions');
const row = (id) => variance(assertions).rows.find((r) => r.control_id === id);

/** Minimal snapshot builder - subjects is a map of subject_id -> variance overrides. */
function snap(controlId, asOf, subjects) {
  return {
    control_id: controlId,
    as_of: asOf,
    population_definition: 'probe',
    source_system: 'probe',
    query_ref: 'probe.sql',
    total: 10,
    passing_count: 10 - Object.keys(subjects).length,
    failing_count: Object.keys(subjects).length,
    failing: Object.entries(subjects).map(([subject_id, v]) => ({
      subject_id,
      reason: 'probe',
      first_observed: v.variance_detected_at ?? asOf,
      variance: { started_at_basis: 'source_system', ...v },
    })),
    passing: null,
    coverage_basis: 'probe',
    confidence_tier: 4,
  };
}

test('an episode opens when a subject starts failing and closes when it stops', () => {
  const eps = varianceEpisodes([
    snap('ctl.x.y.z', '2026-01-01T00:00:00Z', { s1: { variance_detected_at: '2026-01-01T00:00:00Z' } }),
    snap('ctl.x.y.z', '2026-01-08T00:00:00Z', { s1: { variance_detected_at: '2026-01-01T00:00:00Z' } }),
    snap('ctl.x.y.z', '2026-01-15T00:00:00Z', {}),
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].subject_id, 's1');
  assert.equal(eps[0].closed_at, '2026-01-15T00:00:00Z');
  assert.equal(eps[0].close_basis, 'interpolated');
});

test('a subject that fails, recovers, then fails again is two episodes, not one', () => {
  const eps = varianceEpisodes([
    snap('ctl.x.y.z', '2026-01-01T00:00:00Z', { s1: { variance_detected_at: '2026-01-01T00:00:00Z' } }),
    snap('ctl.x.y.z', '2026-01-08T00:00:00Z', {}),
    snap('ctl.x.y.z', '2026-01-15T00:00:00Z', { s1: { variance_detected_at: '2026-01-15T00:00:00Z' } }),
  ]);
  assert.equal(eps.length, 2);
  assert.equal(eps.filter((e) => e.closed_at !== null).length, 1);
  assert.equal(eps.filter((e) => e.closed_at === null).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Censoring. Dropping still-open episodes and averaging the rest biases VD downward, because the
// long-running failures are precisely the ones still open.
// ---------------------------------------------------------------------------------------------
test('still-open episodes are censored, counted, and excluded from the mean', () => {
  const r = row('ctl.iam.cui-enclave.mfa');
  assert.equal(r.episodes, 5);
  assert.equal(r.closed, 1);
  assert.equal(r.censored, 4);
  // The one closed episode drives the mean; the four open ones are not silently treated as zero.
  assert.ok(r.variance_duration_days > 0);
});

test('a control with no closed episode reports no duration rather than zero', () => {
  const r = row('ctl.cui.boundary.asset-inventory');
  assert.equal(r.closed, 0);
  assert.equal(r.variance_duration_days, null, 'zero would claim instant remediation');
  assert.match(formatVariance({ rows: [r] }), /every episode is censored/);
});

// ---------------------------------------------------------------------------------------------
// A single snapshot is a photograph, not a history.
// ---------------------------------------------------------------------------------------------
test('one snapshot yields no frequency at all', () => {
  const r = row('ctl.ir.dibnet.incident-reporting');
  assert.equal(r.snapshots, 1);
  assert.equal(r.window_days, 0);
  assert.equal(r.variance_frequency_per_year, null);
  assert.match(formatVariance({ rows: [r] }), /photograph, not a history/);
});

// ---------------------------------------------------------------------------------------------
// Queue regime and small-sample extrapolation.
// ---------------------------------------------------------------------------------------------
test('a saturated remediation queue is reported as a regime, not as a mean', () => {
  const r = row('ctl.iam.cui-enclave.mfa');
  assert.ok(r.queue_utilisation > SATURATION_THRESHOLD);
  assert.equal(r.saturated, true);
  assert.match(formatVariance({ rows: [r] }), /QUEUE SATURATED/);
});

test('an annualised rate from a short window is labelled as extrapolation', () => {
  const r = row('ctl.iam.cui-enclave.mfa');
  assert.ok(r.window_days < MIN_WINDOW_DAYS);
  assert.equal(r.extrapolated, true);
  const text = formatVariance({ rows: [r] });
  assert.match(text, /EXTRAPOLATION/);
  // The raw count leads; the annualised figure is arithmetic on top of it.
  assert.match(text, /5 episode\(s\) in 14 days/);
});

test('a long window reports the rate without the extrapolation caveat', () => {
  const long = [
    snap('ctl.x.y.z', '2026-01-01T00:00:00Z', { s1: { variance_detected_at: '2026-01-01T00:00:00Z' } }),
    snap('ctl.x.y.z', '2026-06-01T00:00:00Z', {}),
  ];
  const r = variance(long, { controls: [] }).rows[0];
  assert.ok(r.window_days > MIN_WINDOW_DAYS);
  assert.equal(r.extrapolated, false);
  assert.doesNotMatch(formatVariance({ rows: [r] }), /EXTRAPOLATION/);
});

// ---------------------------------------------------------------------------------------------
// started_at basis travels with the result.
// ---------------------------------------------------------------------------------------------
test('episodes with equals_detected are counted and disclosed', () => {
  const r = row('ctl.cui.boundary.asset-inventory');
  assert.equal(r.understated_episodes, 2, 'the two unclassified S3 buckets');
  assert.match(formatVariance({ rows: [r] }), /systematically\s+understated/);
});

test('the segments decompose into the three FAIR-CAM windows', () => {
  const r = row('ctl.iam.cui-enclave.mfa');
  assert.ok(r.segment_monitoring_days > 0, 'started -> detected');
  assert.ok(r.segment_prioritisation_days > 0, 'detected -> remediation started');
  assert.ok(r.segment_implementation_days > 0, 'remediation started -> closed');
});

test('a missing timestamp produces null rather than a fabricated zero segment', () => {
  const r = variance(
    [
      snap('ctl.x.y.z', '2026-01-01T00:00:00Z', {
        s1: { variance_detected_at: '2026-01-01T00:00:00Z', started_at_basis: 'equals_detected' },
      }),
      snap('ctl.x.y.z', '2026-01-08T00:00:00Z', {
        s1: { variance_detected_at: '2026-01-01T00:00:00Z', started_at_basis: 'equals_detected' },
      }),
    ],
    { controls: [] }
  ).rows[0];
  assert.equal(r.segment_monitoring_days, null, 'no variance_started_at means no monitoring window');
  assert.equal(r.segment_implementation_days, null, 'nothing was remediated');
});
