import { readFileSync } from 'node:fs';
import { repoPath } from '../config.mjs';

/**
 * Enclave resources from AWS Config.
 *
 * WHY CONFIG AND NOT THE TAGGING API. The Resource Groups Tagging API is easier to reach and only
 * returns taggable resources, which makes the population quietly incomplete - and an incomplete
 * boundary inventory is the one thing this control cannot tolerate, because every other CUI-scoped
 * control uses it as its denominator. Config is also history-native, which is what the variance
 * layer needs. Config has to be enabled for CMMC anyway, so this is not an extra ask.
 *
 * THE SDK IS AN OPTIONAL DEPENDENCY, loaded lazily, matching the house pattern: the repository must
 * install and test without any AWS package present. An Azure-only or CSV-only org should not be
 * made to download the AWS SDK to run a pipeline that never touches AWS.
 *
 * Credentials come from the standard AWS chain - environment, profile, or an assumed role. There is
 * no credential handling in here on purpose; the chain is well understood and reimplementing it is
 * how credentials end up in a config file.
 *
 * PARTITION MATTERS. GovCloud is a separate partition: us-gov-west-1 / us-gov-east-1, with its own
 * account IDs and ARNs (arn:aws-us-gov:...). A commercial region in `cloud.region` does not error -
 * it queries the wrong partition and returns a confidently empty result, which is exactly the shape
 * of a silent false pass. `cloud.region` is required rather than defaulted for that reason.
 */

export const VERSION = '1.0.0';
export const NAME = 'aws-assets';
export const TABLE = 'src_cloud_resources';
export const CONTROLS = ['ctl.cui.boundary.asset-inventory'];
export const FIXTURE = 'aws-assets';

/**
 * Config advanced query. `SELECT ... WHERE` over the resource configuration index.
 *
 * resourceId rather than ARN because Config guarantees resourceId on every resource type while ARN
 * is absent for a few; the asset inventory needs one stable identifier for every member, and a
 * denominator with holes in it is not a denominator.
 */
export const QUERY =
  "SELECT resourceId, resourceType, awsRegion, accountId, tags WHERE resourceType LIKE 'AWS::%'";

/**
 * Config returns tags in more than one shape depending on the API and resource type - sometimes a
 * list of {key, value}, sometimes a map, sometimes a list of "k=v" strings. Handling all three is
 * not defensive programming for its own sake: getting it wrong drops the owner tag, which turns
 * every correctly-tagged resource into an inventory finding.
 */
export function readTag(tags, name) {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === 'string') {
        const [k, ...rest] = t.split('=');
        if (k?.trim() === name) return rest.join('=').trim() || null;
      } else if (t && typeof t === 'object') {
        const key = t.key ?? t.Key;
        if (key === name) return t.value ?? t.Value ?? null;
      }
    }
    return null;
  }
  if (typeof tags === 'object') return tags[name] ?? null;
  return null;
}

/** Pure grading over parsed Config results. Unit-testable with no AWS account. */
export function grade({ results, collectedAt, ownerTag = 'owner', classificationTag = 'data_classification' }) {
  return results.map((r) => ({
    snapshot_at: collectedAt,
    resource_id: r.resourceId,
    resource_type: r.resourceType ?? null,
    owner_tag: readTag(r.tags, ownerTag),
    data_classification_tag: readTag(r.tags, classificationTag),
    subscription_id: r.accountId ?? null,
    location: r.awsRegion ?? null,
  }));
}

async function loadSdk() {
  try {
    return await import('@aws-sdk/client-config-service');
  } catch {
    return null;
  }
}

export async function collect({ config, collectedAt, fixture = false }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${FIXTURE}.json`), 'utf8'));
    return {
      table: TABLE,
      rows: grade({ results: data.results, collectedAt, ownerTag: config.cloud?.owner_tag, classificationTag: config.cloud?.classification_tag }),
      population: {
        expected: data.results.length,
        examined: data.results.length,
        complete: true,
        source_of_truth: 'FIXTURE - aws-assets.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const region = config.cloud?.region;
  if (!region) {
    return unavailable(
      'cloud.region is not set. AWS GovCloud is us-gov-west-1 or us-gov-east-1; a commercial ' +
        'region queries the wrong partition and returns a confidently empty result.'
    );
  }

  const sdk = await loadSdk();
  if (!sdk) {
    return unavailable(
      '@aws-sdk/client-config-service is not installed. It is an optional dependency so that ' +
        'non-AWS deployments do not carry it: npm install @aws-sdk/client-config-service'
    );
  }

  const { ConfigServiceClient, SelectResourceConfigCommand, SelectAggregateResourceConfigCommand } = sdk;
  const client = new ConfigServiceClient({ region });
  const aggregator = config.cloud?.aggregator;

  const results = [];
  let nextToken;
  try {
    do {
      const command = aggregator
        ? new SelectAggregateResourceConfigCommand({
            Expression: QUERY,
            ConfigurationAggregatorName: aggregator,
            NextToken: nextToken,
          })
        : new SelectResourceConfigCommand({ Expression: QUERY, NextToken: nextToken });

      const page = await client.send(command);
      for (const row of page.Results ?? []) results.push(JSON.parse(row));
      nextToken = page.NextToken;
    } while (nextToken);
  } catch (err) {
    // AccessDenied is not an empty account, and NoSuchConfigurationAggregator is not an empty
    // aggregator. Both mean the population is unknown, which withholds every control over it.
    return unavailable(`AWS Config query failed: ${err.name ?? 'Error'} - ${err.message}`);
  }

  const rows = grade({ results, collectedAt, ownerTag: config.cloud?.owner_tag, classificationTag: config.cloud?.classification_tag });
  const declared = config.cloud?.accounts ?? [];
  const seen = new Set(rows.map((r) => r.subscription_id).filter(Boolean));

  // Without an aggregator a single query only ever sees one account. If the config declares more,
  // saying so is the difference between a partial answer and a partial answer that reads as whole.
  const missingAccounts = declared.filter((a) => !seen.has(a));
  const complete = missingAccounts.length === 0;

  return {
    table: TABLE,
    rows,
    population: {
      expected: rows.length,
      examined: rows.length,
      complete,
      reconciliation: complete
        ? null
        : `declared account(s) ${missingAccounts.join(', ')} returned no resources. ` +
          (aggregator
            ? 'Check the aggregator includes them.'
            : 'No aggregator is configured, so only the credential\'s own account was read - set cloud.aggregator to span accounts.'),
      source_of_truth: aggregator
        ? `AWS Config aggregator ${aggregator} in ${region}`
        : `AWS Config in ${region}, single account`,
    },
    fixture: false,
  };
}

function unavailable(reason) {
  return {
    table: TABLE,
    rows: [],
    population: { expected: null, examined: 0, complete: false, reconciliation: reason, source_of_truth: null },
    unavailable: true,
  };
}
