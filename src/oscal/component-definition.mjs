import { ids, metadata, faircamProps, sortKeys, ref, PROPS_NS } from './common.mjs';
import { loadControls } from '../lib/load.mjs';

/**
 * O1 - Component Definition. Our controls as components, carrying the FAIR-CAM props.
 *
 * This is where the risk layer gets into the OSCAL package. OSCAL has nowhere to put control
 * measurement, so it rides on namespaced props; tools that do not know the namespace ignore them
 * and the document stays spec-legal.
 *
 * Components are grouped by SOURCE SYSTEM rather than one component per control. That reflects
 * the real economics - one enclave IdP integration serves several identity controls - and it is
 * the shape that makes the SSP generated from this readable as a description of a system rather
 * than as a list of requirements.
 */
export function componentDefinition({ measured = [] } = {}) {
  const controls = loadControls();
  const byControl = new Map(measured.map((m) => [m.control_id, m]));

  const bySource = new Map();
  for (const c of controls) {
    bySource.set(c.source_system, [...(bySource.get(c.source_system) ?? []), c]);
  }

  const components = [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, group]) => ({
      uuid: ids.component(source),
      type: 'service',
      title: source,
      description:
        `Evidence source for ${group.length} control(s): ${group.map((c) => c.control_id).join(', ')}.`,
      props: [{ ns: PROPS_NS, name: 'source-system', value: source }],
      'control-implementations': [
        {
          uuid: ids.component(`impl|${source}`),
          source: ref('catalog'),
          description: `Controls evidenced from ${source}.`,
          'implemented-requirements': group.map((c) => ({
            uuid: ids.implementedRequirement(c.control_id, 'house', c.control_id),
            'control-id': c.control_id,
            description: c.assertion,
            props: [
              ...faircamProps(c, null, byControl.get(c.control_id)),
              { ns: PROPS_NS, name: 'population-definition', value: c.population_definition },
              { ns: PROPS_NS, name: 'query-ref', value: c.query_ref },
              { ns: PROPS_NS, name: 'status', value: c.status },
              ...(c.cadence ? [{ ns: PROPS_NS, name: 'cadence', value: c.cadence }] : []),
              ...(c.sla
                ? [
                    { ns: PROPS_NS, name: 'sla-variance-duration-hours', value: String(c.sla.variance_duration_hours) },
                    { ns: PROPS_NS, name: 'sla-clock-starts-at', value: c.sla.clock_starts_at },
                  ]
                : []),
            ],
            'responsible-roles': [{ 'role-id': c.owner }],
          })),
        },
      ],
    }));

  return {
    'component-definition': sortKeys({
      uuid: ids.document('component-definition'),
      metadata: metadata({ title: 'CUI control plane - component definitions' }),
      components,
    }),
  };
}
