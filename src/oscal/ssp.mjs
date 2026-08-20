import { ids, metadata, sortKeys, PROPS_NS } from './common.mjs';
import { loadControls, isFixtureSet } from '../lib/load.mjs';

/**
 * O5 - System Security Plan. GENERATED, NEVER HAND-AUTHORED.
 *
 * This is the highest-leverage single decision in the whole plan for a CMMC engagement, and the
 * reasoning is mechanical rather than aesthetic: assessors weight SSP-to-reality drift heavily,
 * and a generated SSP cannot drift from the controls it was generated from by construction. Every
 * hour spent hand-editing this file is an hour spent creating the exact defect the assessment
 * looks for.
 *
 * If this file is ever edited by hand, the edit is a bug. tests/ssp.test.mjs asserts the output is
 * a pure function of controls/ plus the assertion set, which is what makes that claim checkable
 * rather than a note in a README.
 *
 * Control descriptions come from the control records: scope from population_definition, the
 * requirement from title and the FAIR-CAM function, owner from owner, and the current exception
 * set from failing[]. Nothing is authored here.
 */
export function ssp(assertions) {
  const controls = loadControls();
  const latest = new Map();
  for (const a of assertions) {
    const prev = latest.get(a.control_id);
    if (!prev || a.as_of > prev.as_of) latest.set(a.control_id, a);
  }

  const inBoundary = controls.filter((c) => c.layer !== 'corp-it');

  return {
    'system-security-plan': sortKeys({
      uuid: ids.document('ssp'),
      metadata: {
        ...metadata({
          title: 'CUI control plane - system security plan',
          assertions,
          isFixture: isFixtureSet(assertions),
        }),
        roles: [...new Set(controls.map((c) => c.owner))].sort().map((r) => ({ id: r, title: r })),
        parties: [...new Set(controls.map((c) => c.owner))].sort().map((r) => ({
          uuid: ids.party(r),
          type: 'organization',
          name: r,
        })),
      },
      'import-profile': { href: '#profile-cmmc-l2' },
      'system-characteristics': {
        'system-ids': [{ id: ids.document('system'), 'identifier-type': 'https://ietf.org/rfc/rfc4122' }],
        'system-name': 'CUI enclave',
        description:
          'The CUI boundary as enumerated by ctl.cui.boundary.asset-inventory. The boundary is not ' +
          'described in prose here on purpose: the inventory control produces it, so this ' +
          'description is a pointer to a live population rather than a paragraph that drifts from ' +
          'one. Assessors weight SSP-to-reality drift heavily and this is the mechanism that ' +
          'removes the opportunity for it.',
        'security-sensitivity-level': 'moderate',
        'system-information': {
          'information-types': [
            {
              uuid: ids.document('information-type|cui'),
              title: 'Controlled Unclassified Information',
              description: 'CUI as designated in the contract, handled within the enclave boundary.',
              'confidentiality-impact': { base: 'moderate' },
              'integrity-impact': { base: 'moderate' },
              'availability-impact': { base: 'moderate' },
            },
          ],
        },
        'security-impact-level': {
          'security-objective-confidentiality': 'moderate',
          'security-objective-integrity': 'moderate',
          'security-objective-availability': 'moderate',
        },
        status: { state: 'under-development' },
        'authorization-boundary': {
          description:
            'Scoped as an enclave rather than the general enterprise. Assessment cost, control ' +
            'count and SSP defensibility all follow from this decision, which is why it is Phase 0 ' +
            'and why every control in this plan carries an explicit layer.',
        },
      },
      'system-implementation': {
        users: [],
        components: [...new Set(controls.map((c) => c.source_system))].sort().map((s) => ({
          uuid: ids.component(s),
          type: 'service',
          title: s,
          description: `Evidence source: ${s}.`,
          status: { state: 'operational' },
        })),
      },
      'control-implementation': {
        description:
          'Every statement below is generated from a control record in controls/ and, where ' +
          'evidence exists, from the most recent assertion for that control. No prose in this ' +
          'section is authored by hand.',
        'implemented-requirements': inBoundary.map((c) => implemented(c, latest.get(c.control_id))),
      },
    }),
  };
}

function implemented(control, assertion) {
  const primary = (control.faircam ?? []).find((f) => f.primary)?.function ?? 'unclassified';

  const statement = [
    control.assertion,
    `Scope: ${control.population_definition}`,
    `Owner: ${control.owner}. FAIR-CAM function: ${primary}. Status: ${control.status}.`,
    `Evidence: ${control.source_system}, produced by ${control.query_ref}` +
      (control.cadence ? `, evaluated ${control.cadence}.` : '.'),
  ];

  if (assertion) {
    statement.push(
      `As of ${assertion.as_of}: ${assertion.passing_count} of ${assertion.total} passing. ` +
        assertion.coverage_basis
    );
    if (assertion.failing_count > 0) {
      // Exceptions are the current failing set, stated. An SSP that describes the intended state
      // and omits the live exceptions is precisely the drift an assessor is looking for.
      const grouped = {};
      for (const f of assertion.failing) grouped[f.reason] = (grouped[f.reason] ?? 0) + 1;
      statement.push(
        'Current exceptions: ' +
          Object.entries(grouped).sort().map(([r, n]) => `${r} (${n})`).join(', ') +
          '. Each is enumerated in the POA&M with its variance timestamps.'
      );
    }
  } else {
    statement.push(
      'No assertion has been produced for this control yet, so no claim is made about its ' +
        'operation. This is a gap in the evidence pipeline, stated rather than papered over.'
    );
  }

  return {
    uuid: ids.implementedRequirement(control.control_id, 'ssp', control.control_id),
    'control-id': control.control_id,
    props: [
      { ns: PROPS_NS, name: 'generated', value: 'true' },
      { ns: PROPS_NS, name: 'status', value: control.status },
    ],
    'responsible-roles': [{ 'role-id': control.owner }],
    statements: [
      {
        'statement-id': `${control.control_id}_smt`,
        uuid: ids.implementedRequirement(control.control_id, 'ssp-statement', control.control_id),
        'by-components': [
          {
            'component-uuid': ids.component(control.source_system),
            uuid: ids.implementedRequirement(control.control_id, 'ssp-by-component', control.source_system),
            description: statement.join('\n\n'),
          },
        ],
      },
    ],
  };
}
