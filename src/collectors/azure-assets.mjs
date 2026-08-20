import { readFileSync } from 'node:fs';
import { getToken, armQuery } from './lib/graph.mjs';
import { repoPath } from '../config.mjs';

/**
 * Enclave resources from Azure Resource Graph.
 *
 * Resource Graph rather than per-subscription ARM listing because the question this control asks is
 * "what is actually in the boundary", and that has to be answered across every subscription in one
 * complete pass. Walking resource providers subscription by subscription is slower and, worse,
 * partial in a way that is easy not to notice.
 *
 * Required role: Reader on each enclave subscription. That is all - this collector never writes.
 *
 * NOTE ON GOVERNMENT TENANTS: Azure Government's ARM host is management.usgovcloudapi.net. Set
 * identity.cloud_environment: usgov and this follows it.
 */

export const VERSION = '1.0.0';
export const NAME = 'azure-assets';
export const TABLE = 'src_cloud_resources';
export const CONTROLS = ['ctl.cui.boundary.asset-inventory'];
export const FIXTURE = 'azure-assets';

/**
 * The tags this reads are the organisation's, not Azure's. `owner` and `data_classification` are
 * the two the asset-inventory control tests for, and an untagged resource FAILS that control
 * rather than being skipped - which is the intended behaviour and usually the first real finding a
 * new deployment produces.
 */
export const QUERY = [
  'Resources',
  '| project resource_id = id, resource_type = type, location, subscription_id = subscriptionId,',
  "    owner_tag = tostring(tags['owner']), data_classification_tag = tostring(tags['data_classification'])",
  '| order by resource_id asc',
].join('\n');

export function grade({ resources, collectedAt }) {
  return resources.map((r) => ({
    snapshot_at: collectedAt,
    resource_id: r.resource_id,
    resource_type: r.resource_type ?? null,
    owner_tag: r.owner_tag || null,
    data_classification_tag: r.data_classification_tag || null,
    subscription_id: r.subscription_id ?? null,
    location: r.location ?? null,
  }));
}

export async function collect({ config, collectedAt, fixture = false }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${FIXTURE}.json`), 'utf8'));
    return {
      table: TABLE,
      rows: grade({ resources: data.resources, collectedAt }),
      population: {
        expected: data.resources.length,
        examined: data.resources.length,
        complete: true,
        source_of_truth: 'FIXTURE - azure-assets.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const subscriptions = config.cloud.subscriptions ?? [];
  if (subscriptions.length === 0) {
    // The denominator comes from the profile, deliberately. Querying "whatever the credential can
    // see" would let the enclave boundary drift silently every time somebody is granted a new
    // subscription, and the boundary is the one population that must not move by accident.
    return {
      table: TABLE,
      rows: [],
      population: {
        expected: null,
        examined: 0,
        complete: false,
        reconciliation:
          'cloud.subscriptions is empty in ccp.config.yaml - the enclave boundary must be declared, ' +
          'never inferred from what the credential happens to reach',
        source_of_truth: null,
      },
      unavailable: true,
    };
  }

  const token = await getToken({
    tenantId: process.env.CCP_AZURE_TENANT_ID,
    clientId: process.env.CCP_AZURE_CLIENT_ID,
    clientSecret: process.env.CCP_AZURE_CLIENT_SECRET,
    cloudEnvironment: config.identity.cloud_environment,
    resource: 'arm',
  });

  const resources = await armQuery({
    token,
    cloudEnvironment: config.identity.cloud_environment,
    subscriptions,
    query: QUERY,
  });

  const rows = grade({ resources, collectedAt });
  return {
    table: TABLE,
    rows,
    population: {
      expected: rows.length,
      examined: rows.length,
      complete: true,
      source_of_truth: `Azure Resource Graph over ${subscriptions.length} declared subscription(s)`,
    },
    fixture: false,
  };
}
