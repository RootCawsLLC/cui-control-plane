import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, EXAMPLE_CONFIG } from '../src/config.mjs';
import {
  runPipeline,
  reconciliationNotes,
  MIN_RECONCILIATION_OVERLAP,
  MIN_RECONCILIATION_MEMBERS,
} from '../src/pipeline.mjs';

/**
 * Two sources that are supposed to describe one estate, describing two.
 *
 * Against lab account 445817184167 the asset inventory reported 81 unmanaged assets and 68
 * unclassified ones, which reads as an estate in serious disarray. The CMDB export and the cloud
 * query shared exactly ONE identifier out of 68: AWS Config had no recorder and was answering from
 * a decommissioned index, while the CMDB described resources that genuinely existed. Both sides
 * were well formed and used identical identifier formats - `subnet-0...` on both - so nothing
 * looked broken, and normalising the join key recovered no matches at all.
 *
 * The control had no way to say "these two inputs are not about each other", so it said the only
 * thing it could: that everything was failing.
 */

const mk = (name, table, rows, extra = {}) => ({
  name,
  table,
  rows,
  population: { complete: true },
  ...extra,
});

const ids = (prefix, n, from = 0) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + from).padStart(4, '0')}`);

const cmdb = (values) => mk('csv-cmdb-assets', 'src_cmdb_assets_snapshot', values.map((asset_id) => ({ asset_id })));
const cloud = (values) => mk('aws-assets', 'src_cloud_resources', values.map((resource_id) => ({ resource_id })));

test('near-zero overlap between reconciling sources is reported', () => {
  // The lab shape: 68 against 82, one identifier in common.
  const shared = ids('shared', 1);
  const notes = reconciliationNotes([
    cmdb([...ids('tf', 67), ...shared]),
    cloud([...ids('config', 81), ...shared]),
  ]);

  assert.equal(notes.length, 1);
  assert.match(notes[0], /share 1 of 68 identifiers/);
  assert.match(notes[0], /not describing the same thing|not be describing/i);
  // It must name both sources, or the reader cannot tell which export to go and check.
  assert.match(notes[0], /csv-cmdb-assets/);
  assert.match(notes[0], /aws-assets/);
});

test('a healthy reconciliation is silent', () => {
  const both = ids('asset', 40);
  assert.deepEqual(reconciliationNotes([cmdb(both), cloud(both)]), []);
});

test('partial overlap is normal and stays silent', () => {
  // A real cloud account is full of IAM roles and provider-managed resources no CMDB tracks.
  // Firing on that would train people to ignore the note.
  const shared = ids('shared', 30);
  const notes = reconciliationNotes([
    cmdb([...shared, ...ids('cmdb-only', 38)]),
    cloud([...shared, ...ids('cloud-only', 52)]),
  ]);
  assert.deepEqual(notes, []);
});

test('small populations say nothing about each other', () => {
  const a = ids('a', MIN_RECONCILIATION_MEMBERS - 1);
  const b = ids('b', MIN_RECONCILIATION_MEMBERS - 1);
  // Zero overlap, but too few members for that to be evidence of anything.
  assert.deepEqual(reconciliationNotes([cmdb(a), cloud(b)]), []);
});

test('only declared pairs are compared - endpoints are not cloud resources', () => {
  // Laptops share nothing with cloud resources by nature. src_mdm_devices_snapshot declares no
  // reconciles_with precisely so this cannot be reported as a source error, and a managed endpoint
  // absent from the CMDB stays what it is: a real unmanaged-asset finding.
  const mdm = mk(
    'csv-mdm-devices',
    'src_mdm_devices_snapshot',
    ids('lt', 40).map((device_id) => ({ device_id }))
  );
  assert.deepEqual(reconciliationNotes([mdm, cloud(ids('res', 40))]), []);
  assert.deepEqual(reconciliationNotes([mdm, cmdb(ids('asset', 40))]), []);
});

test('a source that could not be collected is a different problem, already reported', () => {
  const unavailable = mk('aws-assets', 'src_cloud_resources', [], {
    unavailable: true,
    population: { complete: false, reconciliation: 'no recorder' },
  });
  // Reporting "you share 0 identifiers" on top of "this source did not load" would bury the
  // cause under a consequence.
  assert.deepEqual(reconciliationNotes([cmdb(ids('a', 40)), unavailable]), []);
});

test('each pair is reported once, not once per direction', () => {
  const notes = reconciliationNotes([cmdb(ids('a', 40)), cloud(ids('b', 40))]);
  assert.equal(notes.length, 1, 'the pair was reported from both sides');
});

test('the threshold is a documented convention, not a magic number', () => {
  assert.ok(MIN_RECONCILIATION_OVERLAP > 0 && MIN_RECONCILIATION_OVERLAP < 0.5);
  assert.ok(MIN_RECONCILIATION_MEMBERS >= 2);
});

test('the fixture estate reconciles, so a normal run stays quiet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-overlap-'));
  try {
    const config = {
      ...loadConfig(EXAMPLE_CONFIG),
      warehouse: { engine: 'duckdb', path: ':memory:' },
      evidence: { path: dir },
    };
    const result = await runPipeline({
      config,
      fixture: true,
      asOf: '2026-08-20T00:00:00Z',
      log: () => {},
    });
    assert.ok(Array.isArray(result.notes));
    assert.equal(
      result.notes.filter((n) => /same estate/.test(n)).length,
      0,
      'the bundled fixtures should reconcile against each other'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
