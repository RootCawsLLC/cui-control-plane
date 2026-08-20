import { readFileSync } from 'node:fs';
import { repoPath, DEFAULT_PHISHING_RESISTANT_OKTA } from '../config.mjs';

/**
 * Enclave identities from Okta, with their enrolled factors.
 *
 * THREE WAYS THIS DIFFERS FROM THE ENTRA COLLECTOR, none of them cosmetic:
 *
 * 1. PAGINATION IS A LINK HEADER, not a body field. Okta returns RFC 5988 `Link: <url>; rel="next"`
 *    and no cursor in the payload. Code written against Graph's `@odata.nextLink` silently reads
 *    only the first 200 users here - and a truncated population is a control that passes because it
 *    never saw the failures.
 *
 * 2. THERE IS NO TENANT-WIDE FACTOR REPORT. Graph has userRegistrationDetails; Okta does not, so
 *    factors are one call per user. That is genuinely N calls and it is the honest cost of a
 *    complete population - which is the requirement. Concurrency is bounded so a large org does not
 *    trigger org-wide rate limiting, and a 429 is retried rather than being allowed to truncate.
 *
 * 3. FACTOR NAMES ARE DIFFERENT. `webauthn` and `u2f` rather than `fido2SecurityKey`; Okta FastPass
 *    appears as `signed_nonce`. The provider-aware default in config.mjs handles this - carrying
 *    Entra's vocabulary across would mark every phishing-resistant factor as not resistant.
 *
 * Credentials: an API token in CCP_OKTA_API_TOKEN, sent as `Authorization: SSWS <token>`. It needs
 * read access to users and factors - a Read-Only Administrator token is sufficient and is the least
 * privilege that works.
 *
 * GOVERNMENT ORGS: Okta's government cells are okta-gov.com and okta.mil, not okta.com. Same trap as
 * graph.microsoft.us. The org URL comes from config, never a constructed hostname.
 */

export const VERSION = '1.0.0';
export const NAME = 'okta-identities';
export const TABLE = 'src_enclave_idp_users_snapshot';
export const CONTROLS = ['ctl.iam.cui-enclave.mfa'];
export const FIXTURE = 'okta-identities';

/** Bounded so a 20,000-user org does not take the whole org's rate limit budget with it. */
export const CONCURRENCY = 8;

/**
 * Maps an Okta factorType onto the vocabulary the control model tests.
 *
 * The model asks for `webauthn` or `piv_cac`. Okta expresses smart-card authentication as an
 * external IdP rather than a factor, so `piv_cac` only appears where an organisation has said so
 * explicitly - it is never inferred, because inferring it would manufacture a stronger claim than
 * the data supports.
 */
export const RESERVED_TOKENS = new Set(['webauthn', 'piv_cac']);

export function normaliseFactor(factorType, phishingResistant) {
  if (phishingResistant.has(factorType)) {
    return factorType === 'x509' || factorType === 'smartcard' ? 'piv_cac' : 'webauthn';
  }
  // Okta's raw factorType for a security key IS the string 'webauthn', which is also the token the
  // control model treats as passing. So a factor the organisation has deliberately NOT accepted as
  // phishing-resistant would sail through on its name alone. Anything unaccepted is suffixed so it
  // cannot collide with the model's vocabulary.
  return RESERVED_TOKENS.has(factorType) ? `${factorType}:not-accepted` : factorType;
}

/**
 * Pure grading. Takes users plus a map of userId -> factors and returns warehouse rows. No network,
 * so it is unit-testable without an Okta org.
 */
export function grade({ users, factorsByUser, config, collectedAt }) {
  const phishingResistant = new Set(
    config?.identity?.phishing_resistant_methods ?? DEFAULT_PHISHING_RESISTANT_OKTA
  );
  const breakGlassAttr = config?.identity?.break_glass_attribute;
  const breakGlassValue = config?.identity?.break_glass_value ?? 'break-glass';

  return users.map((u) => {
    // Only ACTIVE factors count. An Okta factor can sit in PENDING_ACTIVATION indefinitely, and
    // treating an un-activated enrolment as coverage is how an MFA rollout reports 100% while a
    // slice of the population still signs in with a password.
    const factors = (factorsByUser[u.id] ?? []).filter((f) => f.status === 'ACTIVE');
    const types = factors.map((f) => f.factorType);
    const strongest = types.find((t) => phishingResistant.has(t)) ?? types[0] ?? null;

    const profile = u.profile ?? {};
    return {
      snapshot_at: collectedAt,
      user_id: u.id,
      login: profile.login ?? null,
      // Okta statuses are richer than active/disabled. Anything that is not ACTIVE cannot sign in,
      // so it maps to disabled and drops out of the control population via the model's where clause.
      status: u.status === 'ACTIVE' ? 'active' : 'disabled',
      user_type: profile.userType === 'Guest' ? 'guest' : 'human',
      factor_count: factors.length,
      strongest_factor_type: strongest ? normaliseFactor(strongest, phishingResistant) : null,
      policy_exemptions: [],
      is_break_glass: breakGlassAttr
        ? String(profile[breakGlassAttr] ?? '').toLowerCase() === String(breakGlassValue).toLowerCase()
        : false,
      created_at: u.created ?? null,
      last_updated_at: u.lastUpdated ?? u.created ?? null,
    };
  });
}

/** Parses the `next` URL out of an RFC 5988 Link header. Okta sends `self` too; only `next` matters. */
export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function oktaFetch(url, token, { maxRetries = 5 } = {}) {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      headers: { authorization: `SSWS ${token}`, accept: 'application/json' },
    });
    if (res.status !== 429) return res;
    attempt += 1;
    if (attempt > maxRetries) {
      throw new Error(`okta rate limit exhausted after ${maxRetries} retries on ${url}`);
    }
    // Okta returns x-rate-limit-reset as an epoch second, not a delay.
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const waitMs = Number.isFinite(reset) ? Math.max(1000, reset * 1000 - Date.now()) : 2 ** attempt * 1000;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 60000)));
  }
}

async function pageAll(url, token) {
  const items = [];
  let next = url;
  let pages = 0;
  while (next) {
    const res = await oktaFetch(next, token);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`okta ${res.status} on ${next}: ${body.slice(0, 200)}`);
    }
    items.push(...(await res.json()));
    next = parseNextLink(res.headers.get('link'));
    pages += 1;
  }
  return { items, pages };
}

/** Runs `worker` over `items` with bounded concurrency, preserving nothing but completeness. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function collect({ config, collectedAt, fixture = false }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${FIXTURE}.json`), 'utf8'));
    return {
      table: TABLE,
      rows: grade({ ...data, config, collectedAt }),
      population: {
        expected: data.users.length,
        examined: data.users.length,
        complete: true,
        source_of_truth: 'FIXTURE - okta-identities.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const orgUrl = (config.identity.org_url ?? process.env.CCP_OKTA_ORG_URL ?? '').replace(/\/+$/, '');
  const token = process.env.CCP_OKTA_API_TOKEN;
  if (!orgUrl || !token) {
    return {
      table: TABLE,
      rows: [],
      population: {
        expected: null,
        examined: 0,
        complete: false,
        reconciliation: 'CCP_OKTA_ORG_URL / CCP_OKTA_API_TOKEN not set - population unknown, not empty',
        source_of_truth: null,
      },
      unavailable: true,
    };
  }

  const users = await pageAll(`${orgUrl}/api/v1/users?limit=200`, token);

  const factorLists = await mapLimit(users.items, CONCURRENCY, async (u) => {
    const res = await oktaFetch(`${orgUrl}/api/v1/users/${u.id}/factors`, token);
    if (res.status === 403) {
      // Not the same as "no factors". The token cannot see factors, so the answer is unknown and
      // the whole run must be treated as incomplete rather than reporting everyone unenrolled.
      throw new Error(
        `okta 403 reading factors for ${u.id} - the API token lacks factor read access. ` +
          'A Read-Only Administrator token is sufficient.'
      );
    }
    if (!res.ok) throw new Error(`okta ${res.status} reading factors for ${u.id}`);
    return [u.id, await res.json()];
  });

  const factorsByUser = Object.fromEntries(factorLists);
  const rows = grade({ users: users.items, factorsByUser, config, collectedAt });

  return {
    table: TABLE,
    rows,
    population: {
      expected: users.items.length,
      examined: rows.length,
      complete: true,
      source_of_truth: `Okta org ${orgUrl}`,
      pages: users.pages,
    },
    fixture: false,
  };
}
