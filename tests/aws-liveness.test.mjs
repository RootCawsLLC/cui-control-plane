import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recorderState,
  stalenessDays,
  collect,
  QUERY,
  DEFAULT_MAX_STALENESS_DAYS,
} from '../src/collectors/aws-assets.mjs';

/**
 * Regression suite for a real false pass.
 *
 * On 2026-08-21 this collector returned 82 resources from lab account 445817184167 with
 * `complete: true` at confidence tier 4, from an AWS Config index whose recorder had been deleted.
 * Three of the five S3 buckets it named no longer existed; four that did exist were invisible to it.
 * Config does not error when the recorder is gone - it answers from the residual index.
 *
 * Every test below would have passed vacuously before the liveness check, because the collector
 * never asked whether its source was alive.
 */

const AT = '2026-08-21T00:00:00Z';

/** Minimal SDK stub. Only the two commands the collector uses need to exist. */
function stubSdk({ statuses = [], describeThrows = null, results = [] } = {}) {
  class DescribeConfigurationRecorderStatusCommand {}
  class SelectResourceConfigCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class SelectAggregateResourceConfigCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class ConfigServiceClient {
    async send(command) {
      if (command instanceof DescribeConfigurationRecorderStatusCommand) {
        if (describeThrows) throw describeThrows;
        return { ConfigurationRecordersStatus: statuses };
      }
      return { Results: results.map((r) => JSON.stringify(r)), NextToken: undefined };
    }
  }
  return {
    ConfigServiceClient,
    SelectResourceConfigCommand,
    SelectAggregateResourceConfigCommand,
    DescribeConfigurationRecorderStatusCommand,
  };
}

const client = (sdk) => new sdk.ConfigServiceClient({});
const RECORDING = [{ name: 'default', recording: true, lastStatus: 'SUCCESS' }];

// ---------------------------------------------------------------------------------------------
// recorderState
// ---------------------------------------------------------------------------------------------
test('no recorder at all is refused - this is the exact lab condition', async () => {
  const sdk = stubSdk({ statuses: [] });
  const r = await recorderState(client(sdk), sdk);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no AWS Config recorder exists/);
  assert.match(r.reason, /residual index/);
});

test('a stopped recorder is refused', async () => {
  const sdk = stubSdk({ statuses: [{ name: 'default', recording: false, lastStatus: 'SUCCESS' }] });
  assert.equal((await recorderState(client(sdk), sdk)).ok, false);
});

test('a running recorder that reports FAILURE is refused - running is not capturing', async () => {
  const sdk = stubSdk({
    statuses: [{ name: 'default', recording: true, lastStatus: 'FAILURE', lastErrorMessage: 'delivery failed' }],
  });
  const r = await recorderState(client(sdk), sdk);
  assert.equal(r.ok, false);
  assert.match(r.reason, /delivery failed/);
});

test('one healthy recorder among failures is enough', async () => {
  const sdk = stubSdk({
    statuses: [
      { name: 'a', recording: true, lastStatus: 'FAILURE' },
      { name: 'b', recording: true, lastStatus: 'SUCCESS' },
    ],
  });
  const r = await recorderState(client(sdk), sdk);
  assert.equal(r.ok, true);
  assert.equal(r.recorders, 1);
});

test('being unable to ask is not the same as the answer being yes', async () => {
  const denied = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
  const sdk = stubSdk({ describeThrows: denied });
  const r = await recorderState(client(sdk), sdk);
  assert.equal(r.ok, false, 'an unanswerable liveness question must not be treated as healthy');
  assert.match(r.reason, /unknown currency/);
});

// ---------------------------------------------------------------------------------------------
// stalenessDays - the recorder that is running and capturing nothing
// ---------------------------------------------------------------------------------------------
test('staleness is measured from the NEWEST item, not the oldest', () => {
  const results = [
    { configurationItemCaptureTime: '2026-08-01T00:00:00Z' },
    { configurationItemCaptureTime: '2026-08-20T00:00:00Z' },
  ];
  assert.equal(stalenessDays(results, AT), 1);
});

test('no capture times yields null rather than a fabricated age', () => {
  assert.equal(stalenessDays([{ resourceId: 'x' }], AT), null);
  assert.equal(stalenessDays([], AT), null);
});

test('the query actually selects the field staleness depends on', () => {
  // Without this the staleness check silently degrades to null and never fires.
  assert.match(QUERY, /configurationItemCaptureTime/);
});

// ---------------------------------------------------------------------------------------------
// collect() end to end - the behaviour that regressed
// ---------------------------------------------------------------------------------------------
const config = { cloud: { provider: 'aws-govcloud', region: 'us-gov-west-1' } };

test('collect returns NO rows when the recorder is gone, however much the index still holds', async () => {
  // The index deliberately still has data, exactly as the lab's did. Returning it is the bug.
  const sdk = stubSdk({
    statuses: [],
    results: [{ resourceId: 'i-dead', resourceType: 'AWS::EC2::Instance', configurationItemCaptureTime: AT }],
  });
  const r = await collect({ config, collectedAt: AT, sdk });

  assert.equal(r.rows.length, 0, 'stale rows must not reach the warehouse');
  assert.equal(r.unavailable, true);
  assert.equal(r.population.complete, false);
  assert.match(r.population.reconciliation, /not a live source/);
});

test('collect refuses when the newest item is past the staleness limit', async () => {
  const old = '2026-08-04T00:00:00Z'; // 17 days before AT - the lab's actual age
  const sdk = stubSdk({
    statuses: RECORDING,
    results: [{ resourceId: 'i-1', resourceType: 'AWS::EC2::Instance', configurationItemCaptureTime: old }],
  });
  const r = await collect({ config, collectedAt: AT, sdk });
  assert.equal(r.unavailable, true);
  assert.equal(r.rows.length, 0);
  assert.match(r.population.reconciliation, /17\.0 days old/);
});

test('the staleness limit is configurable, and a raised one lets the same data through', async () => {
  const old = '2026-08-04T00:00:00Z';
  const sdk = stubSdk({
    statuses: RECORDING,
    results: [{ resourceId: 'i-1', resourceType: 'AWS::EC2::Instance', configurationItemCaptureTime: old }],
  });
  const r = await collect({
    config: { cloud: { ...config.cloud, max_staleness_days: 30 } },
    collectedAt: AT,
    sdk,
  });
  assert.equal(r.unavailable ?? false, false);
  assert.equal(r.rows.length, 1);
  assert.ok(DEFAULT_MAX_STALENESS_DAYS < 30, 'the default must be stricter than this override');
});

test('a live recorder with fresh items collects normally', async () => {
  const sdk = stubSdk({
    statuses: RECORDING,
    results: [
      {
        resourceId: 'i-1',
        resourceType: 'AWS::EC2::Instance',
        accountId: '123456789012',
        tags: [{ key: 'owner', value: 'platform' }],
        configurationItemCaptureTime: '2026-08-20T12:00:00Z',
      },
    ],
  });
  const r = await collect({ config, collectedAt: AT, sdk });
  assert.equal(r.unavailable ?? false, false);
  assert.equal(r.population.complete, true);
  assert.equal(r.rows[0].owner_tag, 'platform');
});

test('liveness is checked BEFORE the query, so a dead source costs nothing', async () => {
  let queried = false;
  const sdk = stubSdk({ statuses: [] });
  const OriginalSelect = sdk.SelectResourceConfigCommand;
  sdk.SelectResourceConfigCommand = class extends OriginalSelect {
    constructor(input) {
      super(input);
      queried = true;
    }
  };
  await collect({ config, collectedAt: AT, sdk });
  assert.equal(queried, false, 'no query should be issued against a source known to be dead');
});
