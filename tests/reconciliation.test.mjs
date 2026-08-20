import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, EXAMPLE_CONFIG } from '../src/config.mjs';
import { runPipeline, confidenceTier } from '../src/pipeline.mjs';

/**
 * The asset inventory is a RECONCILIATION, and these tests exist because it silently was not one.
 *
 * The CSV asset collector was registered in the cloud slot but landed in the CMDB table, so the two
 * halves were mutually exclusive: a CSV estate saw only a CMDB and every asset read as managed,
 * while a cloud estate saw only an API and every asset read as absent from the CMDB. A live run
 * against the lab account produced 82 of 82 failing for that one reason, at full confidence.
 *
 * Nothing failed. The suite was green, the validator passed, and the control emitted a number that
 * meant nothing. That is the failure mode these tests pin: not a crash, but a control that reports
 * its own missing source as though it were a finding about the estate.
 */

const withPipeline = async (overrides, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-'));
  try {
    const config = {
      ...loadConfig(EXAMPLE_CONFIG),
      warehouse: { engine: 'duckdb', path: ':memory:' },
      evidence: { path: dir },
      ...overrides,
    };
    const result = await runPipeline({ config, fixture: true, asOf: '2026-08-20T00:00:00Z', log: () => {} });
    await fn(result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const assetAssertion = (r) => {
  const a = r.assertions.find((x) => x.control_id === 'ctl.cui.boundary.asset-inventory');
  assert.ok(a, `asset inventory was withheld: ${JSON.stringify(r.withheld)}`);
  return a;
};

const reasons = (a) => {
  const h = {};
  for (const f of a.failing) h[f.reason] = (h[f.reason] ?? 0) + 1;
  return h;
};

test('the asset inventory reconciles in both directions rather than restating one source', async () => {
  await withPipeline({}, (r) => {
    const a = assetAssertion(r);
    const h = reasons(a);

    // The cloud reports assets the CMDB has never heard of. That is the finding this control is
    // for, and it can only exist when both sides are present.
    assert.ok(h.unmanaged_asset_absent_from_cmdb > 0, 'no unmanaged asset was detected');

    // And it must NOT be the only thing that happens. A population where every member fails for
    // one reason is the signature of a missing source, not of an estate in uniform breach.
    assert.ok(
      Object.keys(h).length > 1,
      `every failure has the same reason (${JSON.stringify(h)}) - that is a missing source, not a finding`
    );
    assert.ok(a.passing_count > 0, 'nothing passed, so the CMDB half is not really loaded');
    assert.ok(a.failing_count > 0, 'nothing failed, so the cloud half is not really loaded');
    assert.equal(a.total, a.passing_count + a.failing_count);
  });
});

test('every source is named in the coverage basis, not just whichever sorted first', async () => {
  await withPipeline({}, (r) => {
    const a = assetAssertion(r);
    for (const name of ['csv-cmdb-assets', 'csv-cloud-resources', 'csv-mdm-devices']) {
      assert.match(
        a.coverage_basis,
        new RegExp(name),
        `${name} contributed to the population but is absent from the coverage basis`
      );
    }
  });
});

test('managed endpoints are in the boundary population at all', async () => {
  await withPipeline({}, (r) => {
    const a = assetAssertion(r);
    const mdm = r.collected.find((c) => c.name === 'csv-mdm-devices');
    assert.ok(mdm && mdm.rows.length > 0, 'the MDM leg collected nothing');
    // Laptops are where CUI is opened. If they never reach the denominator, the inventory is
    // complete only over the asset classes that were easy to enumerate.
    assert.ok(a.total > r.collected.find((c) => c.name === 'csv-cmdb-assets').rows.length);
  });
});

test('a cloud estate with no CMDB is reported as unusable, not as an estate in total breach', async () => {
  await withPipeline({ cmdb: { source: 'none' } }, (r) => {
    const a = r.assertions.find((x) => x.control_id === 'ctl.cui.boundary.asset-inventory');
    if (!a) return; // Withholding it entirely is a stronger, equally acceptable answer.

    const h = reasons(a);
    const only = Object.keys(h);
    // This is the exact shape the lab run produced. It is allowed to happen - but the pipeline
    // must say so rather than let it pass for a measurement, so the uniform-reason note has to
    // fire. Without the note, "82 of 82 failing" reads as a real finding.
    if (only.length === 1 && only[0] === 'unmanaged_asset_absent_from_cmdb') {
      assert.ok(
        r.notes?.some((n) => /one reason/.test(n)),
        'every asset failed for the same reason and nothing flagged it as a probable missing source'
      );
    }
  });
});

test('confidence is the weakest source in the reconciliation, never the best available', () => {
  const api = { name: 'aws-assets', population: { source_of_truth: 'arn:aws:config' } };
  const sheet = { name: 'csv-cmdb-assets', population: { source_of_truth: '/inbox/cmdb-assets.csv' } };

  assert.equal(confidenceTier({ sources: [api], fixture: false }), 4);
  assert.equal(confidenceTier({ sources: [sheet], fixture: false }), 3);
  // A live API reconciled against a hand-exported spreadsheet is a spreadsheet-grade claim.
  assert.equal(confidenceTier({ sources: [api, sheet], fixture: false }), 3);
  assert.equal(confidenceTier({ sources: [api, sheet], fixture: true }), 2);
});

test('a CMDB export with no scope column says so in the record, rather than quietly widening the boundary', async () => {
  const { cmdbAssets } = await import('../src/collectors/csv-sources.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ccp-cmdb-'));
  try {
    const scoped = join(dir, 'scoped.csv');
    const unscoped = join(dir, 'unscoped.csv');
    writeFileSync(scoped, 'asset_id,owner,classification,in_cui_boundary\na-1,team,cui,true\n');
    writeFileSync(unscoped, 'asset_id,owner,classification\na-1,team,cui\n');

    const collectedAt = '2026-08-20T00:00:00Z';
    const withScope = await cmdbAssets.collect({ config: { cmdb: { assets_path: scoped } }, collectedAt });
    const without = await cmdbAssets.collect({ config: { cmdb: { assets_path: unscoped } }, collectedAt });

    assert.equal(withScope.population.reconciliation, undefined);
    // The assumption decides the denominator of the entire CUI-scoped assessment. It is allowed,
    // but it has to be visible in the evidence rather than buried in the collector.
    assert.match(without.population.reconciliation ?? '', /in_cui_boundary/);
    assert.equal(without.rows.length, 1);
    assert.equal(without.rows[0].in_cui_boundary, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
