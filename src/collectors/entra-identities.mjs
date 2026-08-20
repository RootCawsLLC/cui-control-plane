import { readFileSync } from 'node:fs';
import { getToken, getAllPages } from './lib/graph.mjs';
import { repoPath, DEFAULT_PHISHING_RESISTANT } from '../config.mjs';

/**
 * Enclave identities from Entra ID, with their registered authentication methods.
 *
 * WHY THE REPORTING API AND NOT /users/{id}/authentication/methods: the per-user endpoint is one
 * call per identity, which is thousands of calls and a throttling problem for a population this
 * control has to enumerate completely. `reports/authenticationMethods/userRegistrationDetails`
 * returns the same facts for the whole tenant, paged. Completeness is the requirement, so the
 * endpoint that can actually deliver it is the right one.
 *
 * Required application permissions (admin consent needed for all three):
 *   User.Read.All                     - the identity population
 *   AuditLog.Read.All                 - required for userRegistrationDetails, unintuitively
 *   UserAuthenticationMethod.Read.All - registered method detail
 *
 * `ccp doctor` names these, and docs/SETUP.md walks the app registration.
 */

export const VERSION = '1.0.0';
// The full landing table name, matching every other collector. Exporting the bare suffix here
// meant the registry recorded a table that is not a key in TABLES, and the withholding logic
// quietly could not find it.
export const TABLE = 'src_enclave_idp_users_snapshot';
export const CONTROLS = ['ctl.iam.cui-enclave.mfa'];
export const FIXTURE = 'entra-identities';

const SELECT = 'id,userPrincipalName,displayName,accountEnabled,userType,createdDateTime';

/**
 * Pure grading. Takes the two normalised Graph shapes and returns warehouse rows; no network, so
 * it is unit-testable without a tenant. Fetching stays in collect().
 */
export function grade({ users, registration, config, collectedAt }) {
  const phishingResistant = new Set(
    config?.identity?.phishing_resistant_methods ?? DEFAULT_PHISHING_RESISTANT
  );
  const breakGlassAttr = config?.identity?.break_glass_attribute;
  const breakGlassValue = config?.identity?.break_glass_value ?? 'break-glass';
  const excludeGuests = config?.identity?.exclude_guests !== false;

  const byId = new Map(registration.map((r) => [r.id, r]));

  return users
    .filter((u) => (excludeGuests ? u.userType !== 'Guest' : true))
    .map((u) => {
      const reg = byId.get(u.id) ?? {};
      const methods = reg.methodsRegistered ?? [];
      const strongest = methods.find((m) => phishingResistant.has(m)) ?? methods[0] ?? null;

      // A user absent from the registration report has NO registered methods, which is different
      // from "we did not look" - the report covers the whole tenant, so absence is a real answer.
      return {
        snapshot_at: collectedAt,
        user_id: u.id,
        login: u.userPrincipalName ?? null,
        status: u.accountEnabled ? 'active' : 'disabled',
        user_type: u.userType === 'Guest' ? 'guest' : 'human',
        factor_count: methods.length,
        strongest_factor_type: strongest ? normaliseMethod(strongest, phishingResistant) : null,
        policy_exemptions: [],
        is_break_glass: breakGlassAttr
          ? String(u[breakGlassAttr] ?? '').toLowerCase() === String(breakGlassValue).toLowerCase()
          : false,
        created_at: u.createdDateTime ?? null,
        last_updated_at: u.lastUpdatedAt ?? u.createdDateTime ?? null,
      };
    });
}

/**
 * Maps Entra's method names onto the vocabulary the control model tests.
 *
 * The model asks for `webauthn` or `piv_cac` because those are the two shapes 800-171 and the CUI
 * threat model care about. Anything the organisation has declared phishing-resistant maps to
 * webauthn unless it is certificate-based, which is how a PIV/CAC deployment appears.
 */
export const RESERVED_TOKENS = new Set(['webauthn', 'piv_cac']);

export function normaliseMethod(method, phishingResistant) {
  if (phishingResistant.has(method)) return method === 'x509Certificate' ? 'piv_cac' : 'webauthn';
  // Suffixed so an unaccepted method can never collide with the model's passing vocabulary. Entra's
  // names do not collide today; relying on that is relying on Microsoft never shipping one that does.
  return RESERVED_TOKENS.has(method) ? `${method}:not-accepted` : method;
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
        source_of_truth: 'FIXTURE - entra-identities.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const cloudEnvironment = config.identity.cloud_environment;
  const token = await getToken({
    tenantId: process.env.CCP_ENTRA_TENANT_ID,
    clientId: process.env.CCP_ENTRA_CLIENT_ID,
    clientSecret: process.env.CCP_ENTRA_CLIENT_SECRET,
    cloudEnvironment,
  });

  const { graph } = (await import('../config.mjs')).graphEndpoints(cloudEnvironment);
  const extra = config.identity.break_glass_attribute
    ? `,${config.identity.break_glass_attribute}`
    : '';

  const users = await getAllPages(`${graph}/v1.0/users?$select=${SELECT}${extra}&$top=999`, token);
  const registration = await getAllPages(
    `${graph}/v1.0/reports/authenticationMethods/userRegistrationDetails?$top=999`,
    token
  );

  const rows = grade({ users: users.items, registration: registration.items, config, collectedAt });

  return {
    table: TABLE,
    rows,
    population: {
      expected: users.items.length,
      examined: rows.length,
      // The denominator is what the tenant holds; guests are excluded BY POLICY, which reduces
      // coverage rather than shrinking the population, and is stated as such.
      complete: true,
      reconciliation:
        rows.length === users.items.length
          ? null
          : `${users.items.length - rows.length} guest identities excluded by identity.exclude_guests`,
      source_of_truth: `Entra ID tenant ${config.identity.tenant_id ?? process.env.CCP_ENTRA_TENANT_ID}`,
      pages: users.pages + registration.pages,
    },
    fixture: false,
  };
}
