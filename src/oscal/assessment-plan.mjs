import { ids, metadata, sortKeys, ref, resource } from './common.mjs';
import { loadControls } from '../lib/load.mjs';

/**
 * Assessment Plan — emitted because Assessment Results without one is an incomplete object graph.
 *
 * This was not in the original plan and was added because NIST's validator proved it necessary:
 * `import-ap` on assessment-results is not a decorative pointer, the validator FOLLOWS it, and
 * pointing at a document that does not exist fails with FileNotFoundException rather than with
 * anything a reader of the JSON would notice.
 *
 * It is deliberately minimal. The plan is "run the control models over their full populations on
 * their stated cadence" — there is no sampling design to describe, because there is no sampling.
 * That is the whole argument: a questionnaire asks a human to attest, a query asks a system to
 * prove, and the assessment plan for a query is the query.
 */
export function assessmentPlan() {
  const controls = loadControls();
  const inBoundary = controls.filter((c) => c.layer !== 'corp-it');

  return {
    'assessment-plan': sortKeys({
      uuid: ids.document('assessment-plan'),
      metadata: metadata({ title: 'CUI control plane - assessment plan' }),
      'import-ssp': { href: ref('ssp') },
      'back-matter': {
        resources: [resource('ssp', 'System security plan', 'oscal-ssp.json')],
      },
      'reviewed-controls': {
        description:
          'Every control inside the CUI boundary, evaluated over its full population rather than a ' +
          'sample. The evidence is the assertion record plus the query that produced it plus the ' +
          'lineage, which an assessor can re-run to reach the same answer.',
        'control-selections': [
          {
            description:
              'Controls whose layer places them inside the assessed boundary. corp-it layer ' +
              'controls are excluded deliberately - see the CMMC Level 2 profile tailoring statement.',
            'include-controls': [{ 'with-ids': inBoundary.map((c) => c.control_id).sort() }],
          },
        ],
      },
      'assessment-assets': {
        components: [...new Set(controls.map((c) => c.source_system))].sort().map((s) => ({
          uuid: ids.component(s),
          type: 'service',
          title: s,
          description: `Evidence source read by the control models: ${s}.`,
          status: { state: 'operational' },
        })),
      },
      tasks: controls
        .filter((c) => c.cadence)
        .map((c) => ({
          uuid: ids.implementedRequirement(c.control_id, 'task', c.cadence),
          type: 'action',
          title: `${c.control_id} (${c.cadence})`,
          description:
            `Evaluate ${c.query_ref} over: ${c.population_definition}` +
            (c.sla
              ? `\n\nSLA: ${c.sla.variance_duration_hours}h measured from ${c.sla.clock_starts_at}. ${c.sla.authority}`
              : ''),
        })),
    }),
  };
}
