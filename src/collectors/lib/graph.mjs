import { graphEndpoints } from '../../config.mjs';

/**
 * Microsoft Graph and Azure Resource Manager access, client-credentials flow.
 *
 * Plain fetch, no SDK. The Azure SDKs are large, and the three calls this repository makes are a
 * token request, a paged GET, and a Resource Graph POST.
 *
 * GOVERNMENT ENDPOINTS ARE NOT AN EDGE CASE HERE. A DIB contractor holding CUI is very often in
 * GCC High or DoD, where the hosts are login.microsoftonline.us / graph.microsoft.us /
 * management.usgovcloudapi.net. Code that hard-codes the commercial hosts fails against exactly
 * the tenants this tool exists for, and the failure looks like a permissions problem rather than
 * a routing one. Endpoints come from config, always.
 */

export class GraphError extends Error {
  constructor(message, { status, kind }) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Classifies a failure, because these three are NOT the same fact and conflating them is how a
 * collector reports a clean pass over a population it never saw:
 *
 *   auth        - credentials or endpoint wrong. The run is broken; throw.
 *   permission  - authenticated but not consented for this scope. The answer is unknown, so the
 *                 finding is unverifiable - never "no findings".
 *   throttled   - back off and retry; a 429 treated as an empty result is a silent lie.
 */
export function classify(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  if (status === 401) return 'auth';
  if (status === 403) return /consent|scope|privilege|Authorization_RequestDenied/i.test(text) ? 'permission' : 'auth';
  if (status === 429 || status === 503) return 'throttled';
  return 'error';
}

export async function getToken({ tenantId, clientId, clientSecret, cloudEnvironment, resource = 'graph' }) {
  const ep = graphEndpoints(cloudEnvironment);
  const scope = resource === 'arm' ? `${ep.arm}/.default` : `${ep.graph}/.default`;

  const res = await fetch(`${ep.login}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GraphError(
      `token request failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown'}\n` +
        `  endpoint: ${ep.login}\n` +
        '  If this tenant is GCC High or DoD, set identity.cloud_environment: usgov in ccp.config.yaml.',
      { status: res.status, kind: classify(res.status, body) }
    );
  }
  return body.access_token;
}

/**
 * Pages a Graph collection to exhaustion.
 *
 * Exhaustion matters more than it looks. A partial page silently becomes a partial population, and
 * a partial population that is not declared as partial is a pass the evidence does not support -
 * so this follows @odata.nextLink until it is gone and reports how many pages it took, and a
 * throttle is retried rather than being allowed to truncate the set.
 */
export async function getAllPages(url, token, { maxRetries = 5 } = {}) {
  const items = [];
  let next = url;
  let pages = 0;

  while (next) {
    let attempt = 0;
    let res;
    for (;;) {
      res = await fetch(next, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (res.status !== 429 && res.status !== 503) break;
      attempt += 1;
      if (attempt > maxRetries) {
        throw new GraphError(`throttled after ${maxRetries} retries on ${next}`, {
          status: res.status,
          kind: 'throttled',
        });
      }
      const wait = Number(res.headers.get('retry-after') ?? 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const kind = classify(res.status, body);
      throw new GraphError(
        `${res.status} on ${next}: ${body?.error?.message ?? 'unknown'}` +
          (kind === 'permission'
            ? '\n  The app is authenticated but lacks the application permission for this call. ' +
              'See docs/SETUP.md for the exact Graph permissions and remember to grant admin consent.'
            : ''),
        { status: res.status, kind }
      );
    }

    items.push(...(body.value ?? []));
    next = body['@odata.nextLink'] ?? null;
    pages += 1;
  }
  return { items, pages };
}

export async function armQuery({ token, cloudEnvironment, subscriptions, query }) {
  const ep = graphEndpoints(cloudEnvironment);
  const res = await fetch(
    `${ep.arm}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptions, query }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GraphError(`resource graph ${res.status}: ${body?.error?.message ?? 'unknown'}`, {
      status: res.status,
      kind: classify(res.status, body),
    });
  }
  return body.data ?? [];
}
