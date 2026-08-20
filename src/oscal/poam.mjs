import { ids, metadata, sortKeys, PROPS_NS, FAIRCAM_NS } from './common.mjs';
import { loadControls, loadRequirementIndex, isFixtureSet } from '../lib/load.mjs';

/**
 * O4 - POA&M, generated from failing[], carrying the four variance timestamps.
 *
 * Those timestamps are what convert a POA&M from a compliance artifact into a risk artifact. A
 * conventional POA&M says "this is broken and here is a date". This one also says how long it has
 * been broken, how long it took to notice, and how long it sat before anyone acted - which is the
 * decomposition that tells you whether the problem is monitoring, prioritisation, or capacity.
 *
 * TWO REFUSALS ARE ENCODED HERE
 *
 * 1. A requirement on the non-POA&M-able list cannot appear as a POA&M item, at any score. The
 *    list in reference/nist-800-171r2.index.yaml is currently EMPTY AND UNVERIFIED, and that is
 *    a warning rather than a silent pass: an empty unverified list means nobody checked, which is
 *    not the same as there being nothing to check.
 * 2. The 180-day closeout is not tracked on a separate compliance calendar. It is a Variance
 *    Duration SLA like any other, computed from the same timestamps as everything else.
 */

const CLOSEOUT_DAYS = 180;

export function poam(assertions) {
  const controls = new Map(loadControls().map((c) => [c.control_id, c]));
  const index = loadRequirementIndex();
  const nonPoamable = new Set(index.non_poamable?.identifiers ?? []);
  const warnings = [];

  if (index.non_poamable?.verified !== true) {
    warnings.push(
      'non-POA&M-able requirement list is UNVERIFIED and empty. Several 800-171 requirements ' +
        'cannot be carried on a POA&M regardless of score. Verify against the live 32 CFR Part 170 ' +
        'text before relying on this POA&M - an empty unverified list means nobody checked.'
    );
  }

  const items = [];
  for (const a of assertions) {
    const control = controls.get(a.control_id);
    const claimed = (control?.crosswalk ?? [])
      .filter((e) => e.framework === 'nist800171r2')
      .map((e) => e.reference);

    const blocked = claimed.filter((r) => nonPoamable.has(r));
    if (blocked.length > 0) {
      warnings.push(
        `${a.control_id} is refused as a POA&M item: it claims ${blocked.join(', ')}, which cannot ` +
          'be carried on a POA&M regardless of score. It must be remediated, not deferred.'
      );
      continue;
    }

    for (const f of a.failing) {
      items.push(poamItem({ assertion: a, failing: f, control, claimed }));
    }
  }

  return {
    warnings,
    doc: {
      'plan-of-action-and-milestones': sortKeys({
        uuid: ids.document('poam'),
        metadata: metadata({
          title: 'CUI control plane - plan of action and milestones',
          assertions,
          isFixture: isFixtureSet(assertions),
        }),
        'system-id': { 'identifier-type': 'https://ietf.org/rfc/rfc4122', id: ids.document('system') },
        'poam-items': items,
      }),
    },
  };
}

function poamItem({ assertion, failing, control, claimed }) {
  const v = failing.variance ?? {};
  const detected = v.variance_detected_at ?? failing.first_observed;
  const openDays = daysBetween(detected, assertion.as_of);

  const props = [
    { ns: PROPS_NS, name: 'control-id', value: assertion.control_id },
    { ns: PROPS_NS, name: 'subject-id', value: failing.subject_id },
    { ns: PROPS_NS, name: 'reason', value: failing.reason },
    { ns: PROPS_NS, name: 'first-observed', value: failing.first_observed },
    ...(claimed.length ? [{ ns: PROPS_NS, name: 'nist-800-171r2', value: claimed.sort().join(' ') }] : []),
    // The four timestamps. This is the piece almost nobody emits.
    ...(v.variance_started_at ? [{ ns: FAIRCAM_NS, name: 'variance-started-at', value: v.variance_started_at }] : []),
    ...(v.variance_detected_at ? [{ ns: FAIRCAM_NS, name: 'variance-detected-at', value: v.variance_detected_at }] : []),
    ...(v.remediation_started_at ? [{ ns: FAIRCAM_NS, name: 'remediation-started-at', value: v.remediation_started_at }] : []),
    ...(v.remediation_completed_at ? [{ ns: FAIRCAM_NS, name: 'remediation-completed-at', value: v.remediation_completed_at }] : []),
    ...(v.started_at_basis ? [{ ns: FAIRCAM_NS, name: 'started-at-basis', value: v.started_at_basis }] : []),
    ...(openDays !== null ? [{ ns: FAIRCAM_NS, name: 'open-days', value: String(openDays) }] : []),
  ];

  const segments = segmentDurations(v);
  for (const [name, value] of Object.entries(segments)) {
    if (value !== null) props.push({ ns: FAIRCAM_NS, name, value: String(value) });
  }

  return {
    uuid: ids.poamItem(assertion.control_id, failing.subject_id),
    title: `${assertion.control_id} - ${failing.subject_id} - ${failing.reason}`,
    description: describeItem({ assertion, failing, control, openDays, segments, basis: v.started_at_basis }),
    props,
    'related-findings': [{ 'finding-uuid': ids.finding(assertion.control_id, assertion.as_of) }],
  };
}

function describeItem({ assertion, failing, control, openDays, segments, basis }) {
  const lines = [
    `${failing.reason} on ${failing.subject_id}, first observed ${failing.first_observed}.`,
    `Population: ${assertion.population_definition}`,
    `Re-derivable from ${assertion.query_ref} against the ${assertion.as_of} snapshot.`,
  ];

  if (openDays !== null) {
    // The 180-day closeout, computed rather than calendared.
    const remaining = CLOSEOUT_DAYS - openDays;
    lines.push(
      remaining >= 0
        ? `Open ${openDays} days. ${remaining} days remain of the ${CLOSEOUT_DAYS}-day closeout window.`
        : `Open ${openDays} days - PAST the ${CLOSEOUT_DAYS}-day closeout window by ${-remaining} days.`
    );
  }

  const named = Object.entries(segments).filter(([, v]) => v !== null);
  if (named.length > 0) {
    lines.push(
      'Variance segments (which FAIR-CAM function is slow): ' +
        named.map(([k, v]) => `${k.replace(/-/g, ' ')} ${v}d`).join(', ') +
        '.'
    );
  }

  if (basis === 'equals_detected') {
    lines.push(
      'DISCLOSURE: variance_started_at equals variance_detected_at for this item, so the duration ' +
        'above is measured from detection and systematically understates the true window.'
    );
  }

  if (control?.sla) {
    lines.push(`SLA: ${control.sla.variance_duration_hours}h from ${control.sla.clock_starts_at}. ${control.sla.authority}`);
  }
  return lines.join('\n\n');
}

/**
 * started -> detected  : Control Monitoring        (cadence / coverage)
 * detected -> started  : Treatment Sel. & Prior.   (prioritisation / ownership)
 * started -> completed : Implementation            (capacity / tooling)
 */
export function segmentDurations(v) {
  return {
    'segment-monitoring-days': daysBetween(v.variance_started_at, v.variance_detected_at),
    'segment-prioritisation-days': daysBetween(v.variance_detected_at, v.remediation_started_at),
    'segment-implementation-days': daysBetween(v.remediation_started_at, v.remediation_completed_at),
  };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  if (Number.isNaN(ms)) return null;
  return Math.round((ms / 86400000) * 100) / 100;
}
