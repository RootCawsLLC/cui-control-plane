import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Evidence retention, as a FLOOR rather than a delete-after trigger.
 *
 * `evidence.retain_days` is a commitment to keep at least that much history, which is how
 * retention periods read everywhere else in this domain: DFARS 252.204-7012 requires preserving
 * images for at least 90 days, and the 800-171 audit family is written the same way. Nothing in
 * this repository deletes evidence, and the floor is the reason.
 *
 * Read as a ceiling instead, the same number would be actively harmful. `firstObserved` walks
 * history backwards until it finds a snapshot where the subject was passing, so dropping the
 * oldest snapshots silently shortens every open variance episode. Measured against a subject
 * failing continuously across 600 days of monthly snapshots, pruning to a 180-day window reported
 * 180 days of variance duration instead of 600 - a 70% understatement, in the direction that makes
 * a control look better, with nothing marking it. Variance Duration feeds FAIR-CAM and the risk
 * layer, so that number does not stay in the evidence directory.
 *
 * What this module does is measure what is actually held and compare it to what was promised. It
 * never deletes anything, and neither should anything that calls it.
 */

/** Assertion files hold a `fixture: true` stamp; synthetic history is not a retention artifact. */
function readRealAssertions(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (a.fixture === true) continue;
      if (typeof a.as_of === 'string' && typeof a.control_id === 'string') out.push(a);
    } catch {
      // A corrupt file is not history. It is skipped rather than taking the check down, and the
      // span simply does not count it.
    }
  }
  return out;
}

const DAY = 86_400_000;

/**
 * What is held, against what was committed to.
 *
 * `spanDays` is measured from the OLDEST evidence to now, not to the newest. A directory whose
 * newest assertion is six months old has not retained six months of history going forward - it has
 * stopped collecting, and measuring oldest-to-newest would report a comfortable span for a
 * pipeline that died. The staleness of the newest snapshot is reported separately so the two
 * failures cannot be mistaken for each other.
 */
export function retentionStatus({ dir, retainDays, now = Date.now() }) {
  const assertions = readRealAssertions(dir);

  if (assertions.length === 0) {
    return {
      configured: retainDays ?? null,
      snapshots: 0,
      oldest: null,
      newest: null,
      spanDays: 0,
      staleDays: null,
      controls: 0,
      meets: false,
      shortfallDays: retainDays ?? null,
    };
  }

  const stamps = assertions.map((a) => a.as_of).sort();
  const oldest = stamps[0];
  const newest = stamps[stamps.length - 1];
  const spanDays = Math.floor((now - new Date(oldest).getTime()) / DAY);
  const staleDays = Math.floor((now - new Date(newest).getTime()) / DAY);
  const meets = retainDays == null ? true : spanDays >= retainDays;

  return {
    configured: retainDays ?? null,
    snapshots: assertions.length,
    oldest,
    newest,
    spanDays,
    staleDays,
    controls: new Set(assertions.map((a) => a.control_id)).size,
    meets,
    shortfallDays: meets || retainDays == null ? 0 : retainDays - spanDays,
  };
}

/**
 * One line for `doctor`, phrased so a young deployment is not accused of losing anything.
 *
 * Falling short of the floor has two very different causes - not enough time has passed, or
 * evidence that existed is gone - and this cannot tell them apart without a manifest of what
 * should exist. So it reports the shortfall and names both possibilities rather than picking one.
 * Guessing here would either cry wolf at every new install or quietly excuse real loss.
 */
export function describeRetention(status) {
  if (status.configured == null) return 'no retention commitment configured';
  if (status.snapshots === 0) {
    return `no evidence retained yet, against a commitment of ${status.configured} day(s)`;
  }
  const held = `${status.snapshots} snapshot(s) across ${status.controls} control(s), oldest ${status.oldest.slice(0, 10)}`;
  if (status.meets) return `${status.spanDays} day(s) held, commitment ${status.configured} - ${held}`;
  return (
    `${status.spanDays} day(s) held against a commitment of ${status.configured} ` +
    `(${status.shortfallDays} short) - ${held}`
  );
}
