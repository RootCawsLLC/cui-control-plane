import { loadControls, loadRequirementIndex } from './lib/load.mjs';

/**
 * Which of the 110 requirements have at least one control, and at what confidence.
 *
 * The honest shape of this report matters more than the number in it. Three rules:
 *
 * 1. A requirement covered ONLY by low-confidence edges is reported as `weak`, not as covered.
 *    Rounding a low-confidence crosswalk up to coverage is how a Statement of Applicability ends
 *    up claiming ground nobody actually holds.
 * 2. A control whose status is `planned` does not cover anything yet. Coverage is reported twice -
 *    by intent and by what is operating - because the gap between those two is the readiness plan.
 * 3. Uncovered requirements are enumerated, never summarised. "87 of 110" with no list is a
 *    number nobody can act on.
 */
export function coverage() {
  const index = loadRequirementIndex();
  const controls = loadControls();

  const byRequirement = new Map(index.requirements.map((r) => [r.id, []]));

  for (const c of controls) {
    for (const edge of c.crosswalk ?? []) {
      if (edge.framework !== 'nist800171r2') continue;
      byRequirement.get(edge.reference)?.push({ control: c, edge });
    }
  }

  const rows = index.requirements.map((r) => {
    const edges = byRequirement.get(r.id) ?? [];
    const strong = edges.filter((e) => e.edge.confidence !== 'low');
    const operating = strong.filter((e) => e.control.status === 'operating');
    return {
      id: r.id,
      family: r.family_abbrev,
      state:
        operating.length > 0 ? 'operating'
        : strong.length > 0 ? 'intended'
        : edges.length > 0 ? 'weak'
        : 'uncovered',
      controls: edges.map((e) => `${e.control.control_id} (${e.edge.confidence})`),
    };
  });

  const count = (state) => rows.filter((r) => r.state === state).length;

  return {
    requirement_count: index.requirement_count,
    operating: count('operating'),
    intended: count('intended'),
    weak: count('weak'),
    uncovered: count('uncovered'),
    rows,
  };
}

export function formatCoverage(c) {
  const lines = [];
  lines.push(`NIST SP 800-171 Rev 2 coverage - ${c.requirement_count} requirements`);
  lines.push('');
  lines.push(`  operating   ${String(c.operating).padStart(3)}   a control exists, is operating, and the edge is not low-confidence`);
  lines.push(`  intended    ${String(c.intended).padStart(3)}   a control exists but is planned or building`);
  lines.push(`  weak        ${String(c.weak).padStart(3)}   only low-confidence edges - NOT counted as covered`);
  lines.push(`  uncovered   ${String(c.uncovered).padStart(3)}   no control maps here`);
  lines.push('');

  const covered = c.rows.filter((r) => r.state !== 'uncovered');
  if (covered.length > 0) {
    lines.push('Mapped requirements:');
    for (const r of covered) {
      lines.push(`  ${r.id.padEnd(8)} ${r.state.padEnd(10)} ${r.controls.join(', ')}`);
    }
    lines.push('');
  }

  // Enumerated, never summarised. This list IS the Phase 1 backlog.
  const gaps = c.rows.filter((r) => r.state === 'uncovered').map((r) => r.id);
  lines.push(`Uncovered (${gaps.length}) - every one is either a genuine gap or a scoping decision`);
  lines.push('nobody wrote down, and both need a profile-level tailoring statement:');
  for (let i = 0; i < gaps.length; i += 10) {
    lines.push(`  ${gaps.slice(i, i + 10).join('  ')}`);
  }
  return lines.join('\n');
}
