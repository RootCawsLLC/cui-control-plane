import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, EXAMPLE_CONFIG } from '../src/config.mjs';
import {
  runPipeline,
  readPriorEvidence,
  buildAssertion,
  evidenceDirFor,
  refuseToCrossStamps,
} from '../src/pipeline.mjs';

/**
 * Synthetic and real evidence must never share a directory.
 *
 * Both halves of this were live defects. A fixture run wrote `<control>@<date>.json` into the same
 * directory as a live run, so a demo destroyed that day's real evidence - and `.evidence/` is
 * gitignored, so there was nothing to restore from. That half at least announced itself eventually.
 *
 * The quiet half was worse. readPriorEvidence read every JSON in the directory regardless of stamp,
 * so a real assertion resolved `first_observed` against synthetic snapshots. A genuine finding came
 * out dated months earlier than it happened, unstamped, at confidence tier 4, and the fabricated
 * duration fed Variance Duration and then the risk layer. Nothing anywhere said so.
 */

const REAL = { control_id: 'ctl.demo', as_of: '2026-01-01T00:00:00Z', total: 1, failing: [] };
const FIXTURE = { ...REAL, fixture: true };

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-sep-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const control = {
  control_id: 'ctl.demo',
  population_definition: 'x',
  source_system: 's',
  query_ref: 'models/controls/x.sql',
};

test('a fixture run does not write into the real evidence directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-sep-'));
  try {
    // A real assertion for today, exactly as a live run against the lab account left one.
    const file = join(dir, 'ctl.cui.boundary.asset-inventory@2026-08-20.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          control_id: 'ctl.cui.boundary.asset-inventory',
          as_of: '2026-08-20T05:33:58.651Z',
          total: 82,
          passing_count: 0,
          failing_count: 82,
          failing: [],
        },
        null,
        2
      )
    );

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

    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.total, 82, 'a fixture run overwrote real evidence');
    assert.equal(after.as_of, '2026-08-20T05:33:58.651Z');

    assert.notEqual(result.evidenceDir, dir, 'fixture evidence landed in the real directory');
    assert.ok(result.evidenceDir.startsWith(dir), 'fixture evidence escaped the configured tree');
    assert.ok(
      readdirSync(result.evidenceDir).some((f) => f.endsWith('.json')),
      'the fixture run wrote nothing at all'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prior evidence is filtered to the kind of run that is asking', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(REAL));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(FIXTURE));

    const forReal = readPriorEvidence(dir, { fixture: false });
    const forFixture = readPriorEvidence(dir, { fixture: true });

    assert.equal(forReal['ctl.demo']?.length, 1);
    assert.equal(forReal['ctl.demo'][0].fixture, undefined);
    assert.equal(forFixture['ctl.demo']?.length, 1);
    assert.equal(forFixture['ctl.demo'][0].fixture, true);
  });
});

test('a real finding is never dated from a synthetic snapshot', () => {
  withDir((dir) => {
    // A demo left a snapshot claiming this subject has been failing since January.
    writeFileSync(
      join(dir, 'demo.json'),
      JSON.stringify({
        control_id: 'ctl.demo',
        as_of: '2026-01-01T00:00:00Z',
        fixture: true,
        total: 1,
        failing: [
          {
            subject_id: 'subject-A',
            reason: 'made_up',
            first_observed: '2026-01-01T00:00:00Z',
            variance: {
              variance_started_at: null,
              variance_detected_at: '2026-01-01T00:00:00Z',
              remediation_started_at: null,
              remediation_completed_at: null,
              started_at_basis: 'equals_detected',
            },
          },
        ],
      })
    );

    const asOf = '2026-08-20T00:00:00Z';
    const real = buildAssertion({
      control,
      rows: [{ subject_id: 'subject-A', passing: false, reason: 'genuinely_failing' }],
      asOf,
      fixture: false,
      prior: readPriorEvidence(dir, { fixture: false }),
      collected: [
        {
          name: 'aws-assets',
          controls: ['ctl.demo'],
          population: { complete: true, source_of_truth: 'arn:aws' },
        },
      ],
    });

    // Previously this returned 2026-01-01: seven and a half months of fabricated variance
    // duration, on a record carrying no fixture stamp and confidence tier 4.
    assert.equal(real.failing[0].first_observed, asOf);
    assert.equal(real.fixture, undefined);
  });
});

test('overwriting across the stamp boundary is refused, not done quietly', () => {
  withDir((dir) => {
    const file = join(dir, 'x.json');

    writeFileSync(file, JSON.stringify(REAL));
    assert.throws(
      () => refuseToCrossStamps(file, FIXTURE),
      /refusing to overwrite REAL evidence with a FIXTURE run/
    );

    // The reverse is equally wrong: a real run burying a demo artifact means that directory was
    // not what its owner believed it was, and continuing would hide the fact.
    writeFileSync(file, JSON.stringify(FIXTURE));
    assert.throws(() => refuseToCrossStamps(file, REAL), /refusing to overwrite FIXTURE evidence/);

    // Same kind replacing same kind is the normal daily case and stays silent.
    assert.doesNotThrow(() => refuseToCrossStamps(file, FIXTURE));
    assert.doesNotThrow(() => refuseToCrossStamps(join(dir, 'absent.json'), REAL));
  });
});

test('the fixture directory is derived, so existing configs separate without being edited', () => {
  const cfg = { evidence: { path: '.evidence' } };
  const real = evidenceDirFor({ config: cfg, fixture: false });
  const fix = evidenceDirFor({ config: cfg, fixture: true });

  assert.notEqual(real, fix);
  // Nesting is what keeps a real run blind to fixture snapshots: readdirSync does not recurse.
  assert.ok(fix.startsWith(real), 'the fixture directory should nest under the configured path');

  const explicit = evidenceDirFor({
    config: { evidence: { path: '.evidence', fixture_path: '.evidence-demo' } },
    fixture: true,
  });
  assert.ok(explicit.endsWith('.evidence-demo'));
});
