import { loadControls, loadRequirementIndex, loadWeights, isFixtureSet } from './lib/load.mjs';

/**
 * SPRS score, derived from assertion records rather than kept in a spreadsheet.
 *
 * WHAT THIS FILE REFUSES TO DO
 *
 * The 5 / 3 / 1 weighting scheme and the two partial-credit rules are structural and are encoded
 * here. The per-requirement weight ASSIGNMENT is a published table in the DoD Assessment
 * Methodology, and this repository ships it unpopulated on purpose - see reference/sprs-weights.yaml.
 *
 * A guessed weight produces a wrong score; a wrong score is submitted to a Government system of
 * record; and a wrong score is indistinguishable from a right one by inspection. So `score()`
 * throws while any in-scope weight is null and names the offenders, rather than returning a
 * plausible number. fixtures/sprs-weights.fixture.yaml exists so the arithmetic can be tested, and
 * carries `verified: false`, which makes `submittable` false no matter how clean the evidence is.
 *
 * THE DERIVATION
 *
 * A requirement is met when every control crosswalked to it at better-than-low confidence has an
 * assertion with failing_count = 0. Anything else is not met. That is deliberately strict:
 * "mostly met" is not a state the methodology has, and inventing one here would launder a partial
 * control into a full five points.
 */

export class UnverifiedWeights extends Error {}

export function score({ assertions, weightsPath = 'reference/sprs-weights.yaml' }) {
  const index = loadRequirementIndex();
  const controls = loadControls();
  const weightFile = loadWeights(weightsPath);

  const weightById = new Map(weightFile.weights.map((w) => [w.id, w.weight]));
  const latest = new Map();
  for (const a of assertions) {
    const prev = latest.get(a.control_id);
    if (!prev || a.as_of > prev.as_of) latest.set(a.control_id, a);
  }

  // requirement -> the controls that claim it at better-than-low confidence
  const claims = new Map(index.requirements.map((r) => [r.id, []]));
  for (const c of controls) {
    for (const edge of c.crosswalk ?? []) {
      if (edge.framework !== 'nist800171r2' || edge.confidence === 'low') continue;
      claims.get(edge.reference)?.push(c);
    }
  }

  const results = index.requirements.map((r) => {
    const claimed = claims.get(r.id) ?? [];
    const evidenced = claimed.filter((c) => latest.has(c.control_id));
    const met =
      claimed.length > 0 &&
      evidenced.length === claimed.length &&
      evidenced.every((c) => latest.get(c.control_id).failing_count === 0);
    return {
      id: r.id,
      met,
      basis:
        claimed.length === 0 ? 'no_control_claims_this_requirement'
        : evidenced.length < claimed.length ? 'claimed_but_unevidenced'
        : met ? 'evidenced_passing'
        : 'evidenced_failing',
      weight: weightById.get(r.id) ?? null,
    };
  });

  const unmet = results.filter((r) => !r.met);
  const missingWeights = unmet.filter((r) => r.weight === null).map((r) => r.id);

  if (missingWeights.length > 0) {
    throw new UnverifiedWeights(
      `refusing to compute an SPRS score: ${missingWeights.length} unmet requirement(s) have no ` +
        `weight in ${weightsPath}.\n` +
        `  ${missingWeights.slice(0, 20).join(' ')}${missingWeights.length > 20 ? ' ...' : ''}\n` +
        'Populate the weights from the current DoD Assessment Methodology and set verified: true. ' +
        'A guessed weight is a wrong score submitted to a system of record.'
    );
  }

  const deduction = unmet.reduce((sum, r) => sum + r.weight, 0);
  const value = weightFile.scheme.basis - deduction;

  return {
    score: value,
    basis: weightFile.scheme.basis,
    deduction,
    met: results.length - unmet.length,
    unmet: unmet.length,
    // Conditional status under the rule requires a score at or above 88 of 110. Reported as a
    // computed observation about the number, not as a compliance determination - that call is the
    // assessor's and it depends on the POA&M as well as the score.
    at_or_above_conditional_threshold: value >= 88,
    weights_verified: weightFile.verified === true,
    evidence_is_fixture: isFixtureSet(assertions),
    submittable: weightFile.verified === true && !isFixtureSet(assertions),
    results,
  };
}

export function formatScore(s) {
  const lines = [];
  lines.push(`SPRS score: ${s.score} of ${s.basis}   (${s.met} met, ${s.unmet} unmet, -${s.deduction})`);
  lines.push(`  at or above the 88/110 conditional threshold: ${s.at_or_above_conditional_threshold}`);
  lines.push('');
  if (!s.submittable) {
    lines.push('NOT SUBMITTABLE:');
    if (!s.weights_verified) {
      lines.push('  - weights are unverified (verified: false). The arithmetic ran; the inputs are not sourced.');
    }
    if (s.evidence_is_fixture) {
      lines.push('  - evidence set contains fixture assertions (NOT REAL EVIDENCE).');
    }
    lines.push('');
  }
  const byBasis = {};
  for (const r of s.results) byBasis[r.basis] = (byBasis[r.basis] ?? 0) + 1;
  lines.push('Requirement states:');
  for (const [k, v] of Object.entries(byBasis).sort()) lines.push(`  ${String(v).padStart(3)}  ${k}`);
  return lines.join('\n');
}
