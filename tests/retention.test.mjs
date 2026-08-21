import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { retentionStatus, describeRetention } from '../src/retention.mjs';
import { ROOT } from '../src/lib/load.mjs';

/**
 * `evidence.retain_days` is a FLOOR - keep at least this much - not a delete-after trigger.
 *
 * It sat in the schema, defaulted in two places and read by no code, which is how it survived
 * long enough for the reading to matter. Read as a ceiling it would be actively harmful:
 * firstObserved walks history backwards to the last snapshot where the subject was passing, so
 * dropping the oldest snapshots silently shortens every open variance episode. A subject failing
 * across 600 days of monthly snapshots reports 180 days once pruned to a 180-day window - a 70%
 * understatement of Variance Duration, in the direction that flatters the control, feeding
 * FAIR-CAM and the risk layer with nothing marking it.
 *
 * So this measures what is held against what was promised, and deletes nothing.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-21T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

const withDir = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-ret-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const snap = (controlId, as_of, extra = {}) => ({ control_id: controlId, as_of, failing: [], ...extra });

test('no evidence yet is a shortfall of the whole commitment, not a pass', () => {
  withDir({}, (dir) => {
    const s = retentionStatus({ dir, retainDays: 400, now: NOW });
    assert.equal(s.snapshots, 0);
    assert.equal(s.meets, false);
    assert.equal(s.shortfallDays, 400);
  });
});

test('a span shorter than the commitment reports the shortfall', () => {
  withDir(
    { 'a.json': snap('ctl.a', daysAgo(90)), 'b.json': snap('ctl.a', daysAgo(1)) },
    (dir) => {
      const s = retentionStatus({ dir, retainDays: 400, now: NOW });
      assert.equal(s.spanDays, 90);
      assert.equal(s.meets, false);
      assert.equal(s.shortfallDays, 310);
    }
  );
});

test('a span at or beyond the commitment meets it', () => {
  withDir({ 'a.json': snap('ctl.a', daysAgo(400)), 'b.json': snap('ctl.a', daysAgo(0)) }, (dir) => {
    const s = retentionStatus({ dir, retainDays: 400, now: NOW });
    assert.equal(s.meets, true);
    assert.equal(s.shortfallDays, 0);
  });
});

test('fixture history does not count toward a retention commitment', () => {
  withDir(
    {
      'real.json': snap('ctl.a', daysAgo(10)),
      'demo.json': snap('ctl.a', daysAgo(900), { fixture: true }),
    },
    (dir) => {
      const s = retentionStatus({ dir, retainDays: 400, now: NOW });
      // Without the filter the synthetic snapshot would satisfy 400 days on its own.
      assert.equal(s.snapshots, 1);
      assert.equal(s.spanDays, 10);
      assert.equal(s.meets, false);
    }
  );
});

test('the span is measured to now, so a dead pipeline cannot look well retained', () => {
  // Oldest-to-newest would report a comfortable 400 days for a directory that stopped growing
  // six months ago.
  withDir({ 'a.json': snap('ctl.a', daysAgo(580)), 'b.json': snap('ctl.a', daysAgo(180)) }, (dir) => {
    const s = retentionStatus({ dir, retainDays: 400, now: NOW });
    assert.equal(s.spanDays, 580);
    assert.equal(s.staleDays, 180, 'staleness of the newest snapshot is reported separately');
  });
});

test('a corrupt file is skipped rather than taking the check down', () => {
  withDir({ 'good.json': snap('ctl.a', daysAgo(5)), 'bad.json': '{ not json' }, (dir) => {
    const s = retentionStatus({ dir, retainDays: 30, now: NOW });
    assert.equal(s.snapshots, 1);
  });
});

test('no commitment configured is not a failure', () => {
  withDir({ 'a.json': snap('ctl.a', daysAgo(5)) }, (dir) => {
    const s = retentionStatus({ dir, retainDays: undefined, now: NOW });
    assert.equal(s.configured, null);
    assert.equal(s.meets, true);
  });
});

test('the wording does not accuse a young deployment of losing evidence', () => {
  withDir({ 'a.json': snap('ctl.a', daysAgo(3)) }, (dir) => {
    const line = describeRetention(retentionStatus({ dir, retainDays: 400, now: NOW }));
    assert.match(line, /3 day\(s\) held/);
    assert.match(line, /397 short/);
    assert.doesNotMatch(line, /lost|deleted|missing|violat/i);
  });
});

test('nothing in the tool deletes evidence', () => {
  // The floor only means something if no code path removes a snapshot. This is a source-level
  // invariant rather than a behavioural one: a deletion added later would pass every other test
  // in this file while quietly making the commitment unkeepable.
  const dir = join(ROOT, 'src');
  const offenders = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) {
        const text = readFileSync(full, 'utf8');
        for (const call of ['unlinkSync', 'rmSync', 'rmdirSync', 'unlink(', 'rm(']) {
          if (text.includes(call)) offenders.push(`${entry.name}: ${call}`);
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `evidence deletion appeared in src/: ${offenders.join(', ')}`);
});
