import { loadControls, loadExceptions, latestPerControl } from './lib/load.mjs';

/**
 * Policy generation - policy LAST, and generated rather than authored.
 *
 * Order of operations, enforced here and by the validator together:
 *   1. build the control
 *   2. instrument it
 *   3. observe it holding      <- status becomes `operating`
 *   4. THEN write the expectation, generated from the control definition
 *
 * A policy for a control that does not exist is a liability in front of an assessor, and in
 * FAIR-CAM terms it is a Defined Expectations control with no corresponding Loss Event Control:
 * it produces documented misalignment, not risk reduction. So a control that is not `operating`
 * produces no policy text at all, and the reason is printed rather than the control being quietly
 * skipped.
 *
 * Nothing here is authored. Scope comes from population_definition, the requirement from the
 * assertion, the owner from owner, and the exceptions from the exception register plus the live
 * failing[] set. If a section reads badly, fix the control record - that is the point.
 */

export function policy({ assertions = [], controls = loadControls(), exceptions = loadExceptions() } = {}) {
  const latest = new Map(latestPerControl(assertions).map((a) => [a.control_id, a]));
  const eligible = controls.filter((c) => c.status === 'operating');
  const skipped = controls.filter((c) => c.status !== 'operating');

  const byDomain = new Map();
  for (const c of eligible) {
    const domain = c.control_id.split('.')[1];
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), c]);
  }

  const documents = [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, group]) => ({
      filename: `policy-${domain}.md`,
      body: render(domain, group, latest, exceptions),
    }));

  return { documents, skipped };
}

function render(domain, controls, latest, exceptions) {
  const out = [];
  out.push(`# ${domain} policy`);
  out.push('');
  out.push(
    '<!-- GENERATED from controls/ by `ccp policy`. Do not hand edit: the expectation is derived ' +
      'from the operating control, so an edit here creates exactly the documented misalignment ' +
      'this file exists to avoid. Change the control record instead. -->'
  );
  out.push('');
  out.push(
    'Every requirement below describes a control that is **already operating and instrumented**. ' +
      'Nothing is aspirational: if it is written here, there is a query that proves it and a ' +
      'population it is proved over.'
  );
  out.push('');

  for (const c of controls) {
    const a = latest.get(c.control_id);
    const exs = exceptions.filter((e) => e.control_id === c.control_id);

    out.push(`## ${c.title}`);
    out.push('');
    out.push(`**Requirement.** ${c.assertion.trim()}`);
    out.push('');
    out.push(`**Scope.** ${c.population_definition.trim()}`);
    out.push('');
    out.push(`**Owner.** ${c.owner}`);
    out.push('');
    out.push(
      `**How this is verified.** ${c.source_system}, via \`${c.query_ref}\`` +
        (c.cadence ? `, evaluated ${c.cadence}.` : '.') +
        ' The evidence is the query and its full population, not a sample and not a screenshot.'
    );
    out.push('');

    if (c.sla) {
      out.push(
        `**Time limit.** ${c.sla.variance_duration_hours} hours, measured from ` +
          `\`${c.sla.clock_starts_at}\`. ${c.sla.authority.trim()}`
      );
      out.push('');
    }

    if (exs.length > 0) {
      out.push('**Approved exceptions.** An exception reduces coverage; it is not a pass, and it expires.');
      out.push('');
      for (const e of exs) {
        out.push(
          `- \`${e.exception_id}\` — ${e.subjects.length} subject(s), approved by ${e.approved_by}, ` +
            `**expires ${e.expires_at}**. ${e.reason.trim()}`
        );
        for (const comp of e.compensating ?? []) out.push(`  - Compensating: ${comp}`);
      }
      out.push('');
    }

    if (a) {
      out.push(
        `**Current state (${a.as_of}).** ${a.passing_count} of ${a.total} passing. ${a.coverage_basis.trim()}`
      );
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push(
    'Generated from the control inventory. Controls that are not yet operating are deliberately ' +
      'absent — see `ccp policy` output for which, and why.'
  );
  return `${out.join('\n')}\n`;
}

export function formatPolicy({ documents, skipped }) {
  const out = [];
  if (documents.length === 0) {
    out.push('No policy generated, and that is the correct result.');
    out.push('');
    out.push(
      'No control in the inventory has reached status `operating`. Publishing a policy for a control ' +
        'that is not yet holding is a liability in front of an assessor, and in FAIR-CAM terms it is ' +
        'a Defined Expectations control with no Loss Event Control behind it - documented ' +
        'misalignment rather than risk reduction.'
    );
  } else {
    out.push(`Generated ${documents.length} policy document(s):`);
    for (const d of documents) out.push(`  ${d.filename}`);
  }

  if (skipped.length > 0) {
    out.push('');
    out.push('Not eligible (build the control, instrument it, observe it holding, then re-run):');
    for (const c of skipped) {
      out.push(`  ${c.control_id.padEnd(52)} status: ${c.status}`);
    }
  }
  return out.join('\n');
}
