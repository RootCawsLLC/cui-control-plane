import { readFileSync } from 'node:fs';
import { repoPath } from '../config.mjs';

/**
 * The workforce, from AWS IAM Identity Center.
 *
 * THIS IS THE POPULATION THE ENCLAVE MFA CONTROL IS ABOUT — and it is a different set from IAM
 * users. In a federated account the IAM users are service principals and legacy accounts; the
 * humans live in the Identity Store and assume roles. Pointing the control at IAM users there
 * measures the wrong set, which is why `aws-iam-identities` carries its own scope warning and why
 * this collector exists.
 *
 * WHAT IT CANNOT DO, AND WHY THAT IS STATED RATHER THAN PAPERED OVER.
 *
 * Identity Center does not expose per-user MFA enrolment through any public API. Verified against
 * the SDK rather than assumed: neither `@aws-sdk/client-identitystore` nor
 * `@aws-sdk/client-sso-admin` exports a single command matching /mfa|device|credential/. The MFA
 * state visible in the console is not reachable programmatically.
 *
 * The tempting move is to emit `factor_count: 0` and let the control fail everybody. That would be
 * a fabricated finding: it asserts "no MFA enrolled" when the truth is "enrolment is unknowable
 * from here", and it would be indistinguishable from a real failure in the POA&M. So instead the
 * population is reported as ESTABLISHED but INCOMPLETE for this control's purpose, which withholds
 * the control and tells the analyst exactly which door to try next.
 *
 * There are two real ways to close it, and the reconciliation names both:
 *   - federate Identity Center to an external IdP, and collect MFA from Entra or Okta, which this
 *     repository already supports; or
 *   - carry it as a documented manual attestation with a defined cadence, which is legitimate
 *     evidence so long as nobody pretends it is continuous.
 *
 * Permissions, all read-only: sso:ListInstances, sso:DescribeInstance,
 * identitystore:ListUsers, identitystore:ListGroups, identitystore:ListGroupMemberships.
 */

export const VERSION = '1.0.0';
export const NAME = 'aws-identity-center';
export const TABLE = 'src_enclave_idp_users_snapshot';
export const CONTROLS = ['ctl.iam.cui-enclave.mfa'];
export const FIXTURE = 'aws-identity-center';

export const MFA_UNOBTAINABLE =
  'workforce population established, but AWS Identity Center exposes no per-user MFA enrolment via ' +
  'any public API, so the factor state for this population is UNKNOWN rather than absent. Close it ' +
  'by federating to an external IdP and collecting MFA there (identity.provider: entra | okta), or ' +
  'by carrying a documented manual attestation on a defined cadence.';

/**
 * Pure grading. Takes the Identity Store shapes and returns warehouse rows.
 *
 * `factor_count` is null, never 0. Null is the honest value and it is what makes the assertion layer
 * refuse rather than manufacture a population of unenrolled users.
 */
export function grade({ users, membershipsByUser = {}, config, collectedAt }) {
  const breakGlassGroup = config?.identity?.break_glass_group ?? null;

  return users.map((u) => {
    const groups = membershipsByUser[u.UserId] ?? [];

    return {
      snapshot_at: collectedAt,
      user_id: u.UserId,
      login: u.UserName ?? null,
      // ListUsers returns Active: null for stores that do not manage the attribute. Absent is not
      // disabled - treating it as disabled would silently shrink the workforce denominator.
      status: u.Active === false ? 'disabled' : 'active',
      user_type: 'human',
      factor_count: null,
      strongest_factor_type: null,
      policy_exemptions: [],
      // A break-glass identity here is a GROUP membership, not an attribute - Identity Center has no
      // arbitrary user attributes to hang it on.
      is_break_glass: breakGlassGroup ? groups.includes(breakGlassGroup) : false,
      created_at: null,
      last_updated_at: null,
    };
  });
}

async function loadSdk() {
  try {
    const [store, admin] = await Promise.all([
      import('@aws-sdk/client-identitystore'),
      import('@aws-sdk/client-sso-admin'),
    ]);
    return { store, admin };
  } catch {
    return null;
  }
}

async function pageAll(client, CommandCtor, params, key) {
  const out = [];
  let NextToken;
  do {
    const page = await client.send(new CommandCtor({ ...params, NextToken }));
    out.push(...(page[key] ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

export async function collect({ config, collectedAt, fixture = false }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${FIXTURE}.json`), 'utf8'));
    const rows = grade({ ...data, config, collectedAt });
    return {
      table: TABLE,
      rows,
      population: {
        expected: data.users.length,
        examined: rows.length,
        // Established, but not sufficient for THIS control. The distinction is the whole point.
        complete: false,
        reconciliation: `FIXTURE. ${MFA_UNOBTAINABLE}`,
        source_of_truth: 'FIXTURE - aws-identity-center.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const sdk = await loadSdk();
  if (!sdk) {
    return unavailable(
      '@aws-sdk/client-identitystore and @aws-sdk/client-sso-admin are required: ' +
        'npm install @aws-sdk/client-identitystore @aws-sdk/client-sso-admin'
    );
  }

  const { IdentitystoreClient, ListUsersCommand, ListGroupsCommand, ListGroupMembershipsCommand } = sdk.store;
  const { SSOAdminClient, ListInstancesCommand } = sdk.admin;
  const region = config.cloud?.region ?? 'us-east-1';

  try {
    let identityStoreId = config.identity?.identity_store_id;

    if (!identityStoreId) {
      const admin = new SSOAdminClient({ region });
      const instances = await pageAll(admin, ListInstancesCommand, {}, 'Instances');
      if (instances.length === 0) {
        return unavailable(`no Identity Center instance found in ${region}`);
      }
      if (instances.length > 1) {
        // Picking one silently would choose the workforce boundary by accident.
        return unavailable(
          `${instances.length} Identity Center instances found - set identity.identity_store_id to ` +
            'declare which one is the enclave workforce'
        );
      }
      identityStoreId = instances[0].IdentityStoreId;
    }

    const store = new IdentitystoreClient({ region });
    const users = await pageAll(store, ListUsersCommand, { IdentityStoreId: identityStoreId }, 'Users');

    // Group membership only matters for break-glass identification; skipped when unconfigured, so a
    // deployment that does not use it pays nothing for it.
    const membershipsByUser = {};
    if (config.identity?.break_glass_group) {
      const groups = await pageAll(store, ListGroupsCommand, { IdentityStoreId: identityStoreId }, 'Groups');
      for (const g of groups) {
        const members = await pageAll(
          store,
          ListGroupMembershipsCommand,
          { IdentityStoreId: identityStoreId, GroupId: g.GroupId },
          'GroupMemberships'
        );
        for (const m of members) {
          const uid = m.MemberId?.UserId;
          if (!uid) continue;
          membershipsByUser[uid] = [...(membershipsByUser[uid] ?? []), g.DisplayName];
        }
      }
    }

    const rows = grade({ users, membershipsByUser, config, collectedAt });

    return {
      table: TABLE,
      rows,
      population: {
        expected: users.length,
        examined: rows.length,
        // The population IS established. What is missing is the attribute this control tests, and
        // conflating the two would either withhold a good population or pass a bad one.
        complete: false,
        reconciliation: MFA_UNOBTAINABLE,
        source_of_truth: `AWS Identity Center store ${identityStoreId} in ${region}`,
      },
      fixture: false,
    };
  } catch (err) {
    return unavailable(`Identity Center read failed: ${err.name ?? 'Error'} - ${err.message}`);
  }
}

function unavailable(reason) {
  return {
    table: TABLE,
    rows: [],
    population: { expected: null, examined: 0, complete: false, reconciliation: reason, source_of_truth: null },
    unavailable: true,
  };
}
