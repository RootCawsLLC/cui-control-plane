import { FAMILIES, requirements } from '../../scripts/gen-requirement-index.mjs';

/**
 * A synthetic inventory covering all 110 requirements, for testing behaviour AT SCALE.
 *
 * QUARANTINED ON PURPOSE. This never writes into `controls/` and is never loaded by `loadControls()`
 * or by `ccp coverage`. Populating the real inventory with 104 stubs would make coverage report a
 * number describing nothing - invented populations, invented queries, invented owners - which is the
 * exact fabrication this repository refuses everywhere else. `ccp coverage` keeps reporting the true
 * 104 uncovered, and that number stays honest.
 *
 * What it IS for: the emitters, the SPRS scorer, the coverage arithmetic and the variance engine
 * have only ever seen SIX controls. Their behaviour at 110 is untested, and three things that only
 * break at scale are worth pinning:
 *
 *   - UUID collisions. v5 over a fixed namespace should never collide, but "should never" across
 *     110 controls times several frameworks is a claim worth actually checking.
 *   - Emit determinism. Byte-stability has only been proven on a six-control set.
 *   - Quadratic behaviour. An emitter that is fine at 6 and unusable at 110 is a real defect.
 *
 * Deterministic: no clock, no randomness, so a failure reproduces exactly.
 */

const DOMAIN_BY_FAMILY = {
  '3.1': 'iam',
  '3.2': 'people',
  '3.3': 'logging',
  '3.4': 'change',
  '3.5': 'iam',
  '3.6': 'ir',
  '3.7': 'endpoint',
  '3.8': 'data',
  '3.9': 'people',
  '3.10': 'cui',
  '3.11': 'vendor',
  '3.12': 'cui',
  '3.13': 'network',
  '3.14': 'endpoint',
};

/** Stable pseudo-random from the requirement id, so results are reproducible without a seed library. */
function hashInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** One synthetic control per requirement. Ids are namespaced `synthetic` so they cannot be mistaken. */
export function scaleControls() {
  return requirements().map((req) => {
    const domain = DOMAIN_BY_FAMILY[req.family] ?? 'cui';
    const slug = req.id.replace(/\./g, '-');
    const h = hashInt(req.id);

    return {
      control_id: `ctl.${domain}.synthetic.r${slug}`,
      title: `SYNTHETIC control for ${req.id}`,
      assertion: `Every member of the synthetic population for ${req.id} satisfies the synthetic test.`,
      layer: 'synthetic',
      owner: `synthetic-owner-${h % 7}`,
      status: h % 3 === 0 ? 'operating' : 'building',
      faircam: [{ function: 'resistance', primary: true }],
      population_definition: `SYNTHETIC population for requirement ${req.id}. Not a real control.`,
      source_system: 'synthetic',
      query_ref: `models/controls/ctl_${domain}_synthetic_r${slug.replace(/-/g, '_')}.sql`,
      cadence: 'daily',
      crosswalk: [
        {
          framework: 'nist800171r2',
          reference: req.id,
          confidence: 'high',
          basis: 'SYNTHETIC fixture mapping, generated for scale testing. Not a real crosswalk.',
        },
      ],
      scenarios: [],
    };
  });
}

/** One assertion per synthetic control, with a deterministic spread of failures. */
export function scaleAssertions({ asOf = '2026-08-21T00:00:00Z' } = {}) {
  return scaleControls().map((c) => {
    const h = hashInt(c.control_id);
    const total = 10 + (h % 90);
    const failingCount = h % 5 === 0 ? 1 + (h % 4) : 0;

    const failing = Array.from({ length: failingCount }, (_, i) => ({
      subject_id: `${c.control_id}:subject-${i}`,
      reason: 'synthetic_failure',
      first_observed: asOf,
      variance: {
        variance_started_at: null,
        variance_detected_at: asOf,
        remediation_started_at: null,
        remediation_completed_at: null,
        started_at_basis: 'equals_detected',
      },
    }));

    return {
      control_id: c.control_id,
      as_of: asOf,
      population_definition: c.population_definition,
      source_system: 'synthetic',
      query_ref: c.query_ref,
      total,
      passing_count: total - failingCount,
      failing_count: failingCount,
      failing,
      passing: null,
      coverage_basis: 'SYNTHETIC fixture. NOT REAL EVIDENCE - generated for scale testing.',
      confidence_tier: 2,
      source_kind: 'queried',
      fixture: true,
    };
  });
}

export const EXPECTED_CONTROLS = requirements().length;
export const FAMILY_COUNT = FAMILIES.length;
