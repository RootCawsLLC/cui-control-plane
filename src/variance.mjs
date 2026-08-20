import { loadControls } from './lib/load.mjs';

/**
 * Variance Frequency and Variance Duration, derived from assertion history.
 *
 * This is the file the whole repository is an argument for. Everything upstream satisfies an
 * assessor; this converts the same data into control reliability, which is an input to loss event
 * frequency. Without it the pipeline is a very well-tested dashboard.
 *
 * A VARIANCE EPISODE is a maximal run of consecutive snapshots in which one subject is failing one
 * control. It opens when the subject first appears in failing[] and closes on the first snapshot
 * where it is absent while the control is still being observed.
 *
 * THREE THINGS THIS GETS RIGHT THAT ARE EASY TO GET WRONG
 *
 * 1. CENSORING. An episode still open at the last snapshot has no duration yet. Dropping those and
 *    averaging the rest biases Variance Duration DOWNWARD - the long-running failures are exactly
 *    the ones still open. Open episodes are counted, reported, and excluded from the mean with the
 *    exclusion stated, never silently.
 *
 * 2. QUEUE REGIME. Remediation is a queue: arrivals are VF, service is throughput. Above roughly
 *    0.7 utilisation, duration goes non-linear and a mean stops being a useful summary. Past that
 *    the regime is reported instead of the average, because reporting a mean there is worse than
 *    reporting nothing.
 *
 * 3. STARTED_AT BASIS. Where variance_started_at was set equal to variance_detected_at, duration
 *    measured from onset is systematically understated and any reliability derived from it is an
 *    upper bound. The proportion of episodes in that state travels with the result.
 */

const DAY_MS = 86400000;
const YEAR_DAYS = 365.25;

/** Utilisation above this and the mean stops being trustworthy; report the regime instead. */
export const SATURATION_THRESHOLD = 0.7;

/**
 * Below this observation window, an annualised rate is extrapolation rather than measurement.
 *
 * Multiplying six episodes in a fortnight by 26 produces a confident-looking three-figure
 * frequency built on six data points. The arithmetic is right and the number is not usefully
 * precise, so the raw count and the window travel with it and the annualised figure is labelled
 * as an extrapolation. A quarter is the point at which seasonal and release-cycle effects start
 * being represented at all.
 */
export const MIN_WINDOW_DAYS = 90;

export function varianceEpisodes(assertions) {
  const byControl = new Map();
  for (const a of assertions) {
    byControl.set(a.control_id, [...(byControl.get(a.control_id) ?? []), a]);
  }

  const episodes = [];
  for (const [controlId, snapshotsUnsorted] of byControl) {
    const snapshots = [...snapshotsUnsorted].sort((a, b) => a.as_of.localeCompare(b.as_of));
    const open = new Map(); // subject_id -> episode under construction

    for (const snap of snapshots) {
      const failingNow = new Map(snap.failing.map((f) => [f.subject_id, f]));

      // Close episodes whose subject is no longer failing. The close timestamp is the source's own
      // remediation_completed_at where it recorded one; otherwise this snapshot, which bounds the
      // close to the collection interval rather than inventing precision.
      for (const [subject, ep] of [...open]) {
        if (failingNow.has(subject)) continue;
        ep.closed_at = ep.remediation_completed_at ?? snap.as_of;
        ep.close_basis = ep.remediation_completed_at ? 'source_system' : 'interpolated';
        episodes.push(ep);
        open.delete(subject);
      }

      for (const [subject, f] of failingNow) {
        const existing = open.get(subject);
        if (existing) {
          // Still failing. Remediation timestamps can arrive after the episode opened.
          existing.remediation_started_at ??= f.variance?.remediation_started_at ?? null;
          existing.remediation_completed_at ??= f.variance?.remediation_completed_at ?? null;
          existing.last_seen = snap.as_of;
          continue;
        }
        const v = f.variance ?? {};
        open.set(subject, {
          control_id: controlId,
          subject_id: subject,
          reason: f.reason,
          started_at: v.variance_started_at ?? null,
          started_at_basis: v.started_at_basis ?? 'equals_detected',
          detected_at: v.variance_detected_at ?? f.first_observed,
          remediation_started_at: v.remediation_started_at ?? null,
          remediation_completed_at: v.remediation_completed_at ?? null,
          first_seen: snap.as_of,
          last_seen: snap.as_of,
          closed_at: null,
          close_basis: null,
        });
      }
    }

    // Whatever is still open at the last snapshot is CENSORED, not zero-duration and not closed.
    for (const ep of open.values()) episodes.push(ep);
  }

  return episodes.sort(
    (a, b) => a.control_id.localeCompare(b.control_id) || a.subject_id.localeCompare(b.subject_id)
  );
}

const days = (from, to) => {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isNaN(ms) ? null : ms / DAY_MS;
};

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
const round = (x, n = 2) => (x === null ? null : Math.round(x * 10 ** n) / 10 ** n);

export function variance(assertions, { controls = loadControls() } = {}) {
  const episodes = varianceEpisodes(assertions);
  const byControl = new Map();
  for (const a of assertions) {
    byControl.set(a.control_id, [...(byControl.get(a.control_id) ?? []), a.as_of]);
  }

  const controlIndex = new Map(controls.map((c) => [c.control_id, c]));

  const rows = [...byControl.keys()].sort().map((controlId) => {
    const stamps = byControl.get(controlId).sort();
    const windowDays = days(stamps[0], stamps.at(-1));
    const eps = episodes.filter((e) => e.control_id === controlId);
    const closed = eps.filter((e) => e.closed_at !== null);
    const openEps = eps.filter((e) => e.closed_at === null);

    // A single snapshot is a photograph, not a history. VF is undefined over a zero-length window
    // and saying so is better than dividing by something small and reporting a huge number.
    const observable = windowDays !== null && windowDays > 0;

    const durations = closed.map((e) => days(e.detected_at, e.closed_at)).filter((d) => d !== null);
    const vf = observable ? (eps.length / windowDays) * YEAR_DAYS : null;
    const throughput = observable ? (closed.length / windowDays) * YEAR_DAYS : null;
    const utilisation = observable && throughput > 0 ? vf / throughput : null;

    const understated = eps.filter((e) => e.started_at_basis === 'equals_detected').length;

    return {
      control_id: controlId,
      title: controlIndex.get(controlId)?.title ?? controlId,
      snapshots: stamps.length,
      window_days: round(windowDays),
      episodes: eps.length,
      closed: closed.length,
      censored: openEps.length,
      variance_frequency_per_year: round(vf),
      variance_duration_days: round(mean(durations)),
      // Segment means answer WHICH FAIR-CAM function is slow, which is the whole reason for
      // carrying four timestamps instead of two.
      segment_monitoring_days: round(mean(eps.map((e) => days(e.started_at, e.detected_at)).filter((d) => d !== null))),
      segment_prioritisation_days: round(
        mean(eps.map((e) => days(e.detected_at, e.remediation_started_at)).filter((d) => d !== null))
      ),
      segment_implementation_days: round(
        mean(eps.map((e) => days(e.remediation_started_at, e.closed_at)).filter((d) => d !== null))
      ),
      queue_utilisation: round(utilisation),
      extrapolated: observable && windowDays < MIN_WINDOW_DAYS,
      saturated: utilisation !== null && utilisation > SATURATION_THRESHOLD,
      understated_episodes: understated,
      sla_hours: controlIndex.get(controlId)?.sla?.variance_duration_hours ?? null,
    };
  });

  return { rows, episodes };
}

export function formatVariance({ rows }) {
  const out = [];
  out.push('Variance Frequency and Variance Duration, from assertion history');
  out.push('');

  for (const r of rows) {
    out.push(`${r.control_id}`);
    out.push(`  ${r.snapshots} snapshot(s) over ${r.window_days ?? 0} days`);

    if (r.snapshots < 2) {
      // One snapshot is a photograph. Refusing to print a frequency here is the same discipline as
      // the SPRS scorer refusing an unweighted score.
      out.push('  VF/VD: not computable from a single snapshot - this is a photograph, not a history.');
      out.push('');
      continue;
    }

    out.push(`  episodes: ${r.episodes}  (closed ${r.closed}, still open ${r.censored})`);
    if (r.extrapolated) {
      // Say the count first. The annualised figure is arithmetic on top of it, not a measurement,
      // and leading with the big number would be the false precision this repository objects to.
      out.push(
        `  VF: ${r.episodes} episode(s) in ${r.window_days} days` +
          ` -- annualises to ${r.variance_frequency_per_year}/year, but that is EXTRAPOLATION from a` +
          ` window under ${MIN_WINDOW_DAYS} days. Treat the count as the finding, not the rate.`
      );
    } else {
      out.push(`  VF: ${r.variance_frequency_per_year ?? 'n/a'} episodes/year`);
    }

    if (r.variance_duration_days === null) {
      out.push('  VD: no closed episode yet - every episode is censored, so no duration can be stated.');
    } else {
      out.push(
        `  VD: ${r.variance_duration_days} days (mean over ${r.closed} closed episode(s))` +
          (r.censored > 0
            ? `  -- EXCLUDES ${r.censored} still-open episode(s); the long-running failures are the ones still open, so this is a LOWER bound.`
            : '')
      );
    }

    const seg = [
      ['monitoring', r.segment_monitoring_days],
      ['prioritisation', r.segment_prioritisation_days],
      ['implementation', r.segment_implementation_days],
    ].filter(([, v]) => v !== null);
    if (seg.length > 0) {
      out.push(`  segments: ${seg.map(([k, v]) => `${k} ${v}d`).join(', ')}`);
    }

    if (r.saturated) {
      out.push(
        `  QUEUE SATURATED: utilisation ${r.queue_utilisation} (arrivals vs. closures). Above ` +
          `${SATURATION_THRESHOLD} duration goes non-linear - report the regime, not the mean.`
      );
    } else if (r.queue_utilisation !== null) {
      out.push(`  queue utilisation: ${r.queue_utilisation}`);
    }

    if (r.understated_episodes > 0) {
      out.push(
        `  DISCLOSURE: ${r.understated_episodes} of ${r.episodes} episode(s) have ` +
          'variance_started_at = variance_detected_at. Duration from onset is systematically ' +
          'understated and any reliability derived from this is an upper bound.'
      );
    }

    if (r.sla_hours !== null) {
      out.push(`  SLA: ${r.sla_hours}h`);
    }
    out.push('');
  }

  out.push('These are the inputs to control reliability, and thence to loss event frequency for the');
  out.push('scenarios in scenarios/. They are not the scenario quantification itself - that needs');
  out.push('loss data this repository does not hold. See docs/watch-items.md.');
  return out.join('\n');
}
