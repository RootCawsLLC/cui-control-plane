import { ids, metadata, faircamProps, sortKeys, lastModified, ref, resource, PROPS_NS } from './common.mjs';
import { loadControls, isFixtureSet, FIXTURE_STAMP } from '../lib/load.mjs';

/**
 * O3 - Assessment Results. The assertion records, serialized.
 *
 * Most OSCAL implementations stop before this model, which is a shame: it is the join between the
 * compliance artifacts and live control state, and it is the one model that maps naturally onto
 * observations a machine actually has, so it can be generated incrementally from real evidence
 * rather than requiring a complete interlocking object graph first.
 *
 * THE ROUNDING-UP TRAP, stated so it is not walked into: OSCAL's finding vocabulary is
 * satisfied / not-satisfied and nothing else. Any control with a non-empty failing[] is
 * not-satisfied here, including one failing item out of forty thousand. It is never rounded up,
 * and the population numbers ride along in props so the reader can see the difference between
 * "one exception" and "nothing works" that the enum cannot express.
 */
export function assessmentResults(assertions, { measured = [] } = {}) {
  const controls = new Map(loadControls().map((c) => [c.control_id, c]));
  const byControl = new Map(measured.map((m) => [m.control_id, m]));
  const isFixture = isFixtureSet(assertions);

  const observations = assertions.map((a) => ({
    uuid: ids.observation(a.control_id, a.as_of),
    title: a.control_id,
    description: a.population_definition,
    methods: ['TEST'],
    types: ['control-objective'],
    collected: a.as_of,
    props: [
      { ns: PROPS_NS, name: 'total', value: String(a.total) },
      { ns: PROPS_NS, name: 'passing-count', value: String(a.passing_count) },
      { ns: PROPS_NS, name: 'failing-count', value: String(a.failing_count) },
      { ns: PROPS_NS, name: 'source-system', value: a.source_system },
      { ns: PROPS_NS, name: 'query-ref', value: a.query_ref },
      { ns: PROPS_NS, name: 'confidence-tier', value: String(a.confidence_tier) },
      ...(a.fixture ? [{ ns: PROPS_NS, name: 'fixture', value: 'true' }] : []),
      ...faircamProps(controls.get(a.control_id) ?? { faircam: [] }, a.as_of, byControl.get(a.control_id)),
    ],
    remarks:
      `Population: ${a.total} examined from ${a.source_system} via ${a.query_ref}. ` +
      `${a.coverage_basis}` +
      (a.fixture ? ` ${FIXTURE_STAMP}.` : ''),
  }));

  const findings = assertions.map((a) => {
    const satisfied = a.failing_count === 0;
    return {
      uuid: ids.finding(a.control_id, a.as_of),
      title: `${a.control_id} - ${controls.get(a.control_id)?.title ?? a.control_id}`,
      description: describe(a, controls.get(a.control_id)),
      target: {
        type: 'objective-id',
        'target-id': a.control_id,
        status: {
          state: satisfied ? 'satisfied' : 'not-satisfied',
          ...(satisfied
            ? {}
            : {
                reason: 'failed',
                remarks:
                  `${a.failing_count} of ${a.total} failing. OSCAL has no partial state, so this is ` +
                  'reported as not-satisfied rather than rounded up; the counts in the related ' +
                  'observation carry the proportion.',
              }),
        },
      },
      'related-observations': [{ 'observation-uuid': ids.observation(a.control_id, a.as_of) }],
    };
  });

  return {
    'assessment-results': sortKeys({
      uuid: ids.document('assessment-results'),
      metadata: metadata({ title: 'CUI control plane - assessment results', assertions, isFixture }),
      'import-ap': { href: ref('assessment-plan') },
      'back-matter': { resources: [resource('assessment-plan', 'Assessment plan', 'oscal-assessment-plan.json')] },
      results: [
        {
          uuid: ids.result('all', lastModified(assertions)),
          title: 'Continuous control monitoring',
          description:
            'Assertions produced by the dbt control models over full populations. Each finding is ' +
            're-derivable by running the query named in its observation against the same snapshot.',
          start: assertions.map((a) => a.as_of).sort()[0] ?? lastModified(assertions),
          end: lastModified(assertions),
          'reviewed-controls': {
            // SelectControlById, not the profile's with-ids. See assessment-plan.mjs.
            'control-selections': [
              {
                'include-controls': [...new Set(assertions.map((a) => a.control_id))]
                  .sort()
                  .map((id) => ({ 'control-id': id })),
              },
            ],
          },
          observations,
          findings,
        },
      ],
    }),
  };
}

function describe(a, control) {
  const parts = [
    `${a.passing_count} of ${a.total} passing as of ${a.as_of}.`,
    a.coverage_basis,
  ];
  if (a.failing_count > 0) {
    // failing[] is always enumerated. It is the work queue and the variance record, and a summary
    // here would remove the only thing anyone can act on.
    const grouped = {};
    for (const f of a.failing) grouped[f.reason] = (grouped[f.reason] ?? 0) + 1;
    parts.push(
      `Failing by reason: ${Object.entries(grouped).sort().map(([r, n]) => `${r} (${n})`).join(', ')}.`
    );
    const bases = new Set(a.failing.map((f) => f.variance?.started_at_basis).filter(Boolean));
    if (bases.has('equals_detected')) {
      parts.push(
        'DISCLOSURE: at least one failing item has variance_started_at equal to ' +
          'variance_detected_at. Variance Duration derived from this set is systematically ' +
          'understated and the resulting control reliability is an upper bound.'
      );
    }
  }
  if (control?.sla) {
    parts.push(`SLA: ${control.sla.variance_duration_hours}h from ${control.sla.clock_starts_at}. ${control.sla.authority}`);
  }
  return parts.join('\n\n');
}
