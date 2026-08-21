import { readFileSync } from 'node:fs';
import { repoPath } from '../config.mjs';

/**
 * Enclave identities from AWS IAM.
 *
 * WHEN THIS IS THE RIGHT COLLECTOR, AND WHEN IT IS A LIE. Entra and Okta are identity providers;
 * AWS IAM is an authorisation system for one cloud account that happens to hold user records. For an
 * organisation whose people sign in through an IdP and assume roles, IAM users are service
 * principals and break-glass accounts - a population of two or three, not the enclave workforce, and
 * pointing this control at them would produce a flattering number about the wrong set.
 *
 * It is the right collector for the smaller case that is common among DIB subcontractors: a single
 * AWS account, IAM users as the actual human sign-in path, no federation. Then these ARE the human
 * identities in the boundary.
 *
 * The tool cannot tell which case it is in, so it does not guess. `identity.provider: aws-iam` is
 * the organisation asserting the first case, and the assertion records that claim in
 * `population_definition` so an assessor sees what was counted rather than inferring it.
 *
 * WHAT COUNTS AS A FACTOR. Only a registered MFA device. An access key is not a factor - it is a
 * long-lived bearer credential, and treating one as authentication strength is how a population of
 * key-only automation accounts reports as "authenticated". Keys are carried separately so the
 * variance record can say WHY a principal failed.
 *
 * Required permissions - all read-only, and `iam:GetCredentialReport` is the important one:
 *   iam:ListUsers, iam:ListMFADevices, iam:ListAccessKeys, iam:GenerateCredentialReport,
 *   iam:GetCredentialReport
 */

export const VERSION = '1.0.0';
export const NAME = 'aws-iam-identities';
export const TABLE = 'src_enclave_idp_users_snapshot';
export const CONTROLS = ['ctl.iam.cui-enclave.mfa'];
export const FIXTURE = 'aws-iam-identities';

/**
 * The credential report is one call for the whole account and carries `mfa_active`,
 * `password_enabled` and key rotation dates for every user. The alternative - ListMFADevices per
 * user - is N calls and throttles on a large account, the same trade the Okta collector loses and
 * this one wins.
 *
 * `password_enabled` is what separates a human sign-in path from an automation principal, and it is
 * the field that makes this collector honest: a user with no console password cannot be phished
 * through the console, so counting it as an unenrolled human overstates the failure.
 */
export function parseCredentialReport(csvText) {
  const [headerLine, ...lines] = csvText.trim().split('\n');
  const headers = headerLine.split(',').map((h) => h.trim());
  return lines
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split(',').map((v, i) => [headers[i], v.trim()])));
}

const yes = (v) => String(v ?? '').toLowerCase() === 'true';

/** Pure grading. No network, so it is unit-testable without an account. */
export function grade({ report, config, collectedAt }) {
  const includeNoConsole = config?.identity?.include_console_disabled === true;

  return report
    // The account root user is not a workforce identity and cannot be managed like one. It is
    // excluded here and belongs to a separate control about root usage entirely - folding it in
    // would put an unfixable failure in a population people are meant to remediate.
    .filter((u) => u.user !== '<root_account>')
    .filter((u) => (includeNoConsole ? true : yes(u.password_enabled)))
    .map((u) => {
      const mfa = yes(u.mfa_active);
      const keyCount = [yes(u.access_key_1_active), yes(u.access_key_2_active)].filter(Boolean).length;

      return {
        snapshot_at: collectedAt,
        user_id: u.arn || u.user,
        login: u.user,
        status: yes(u.password_enabled) ? 'active' : 'disabled',
        user_type: 'human',
        // A virtual or hardware MFA device is one factor. IAM does not distinguish device type in
        // the credential report, so this never claims more than one.
        factor_count: mfa ? 1 : 0,
        // IAM MFA is TOTP or a hardware key and the report cannot tell them apart. Claiming
        // `webauthn` would assert phishing resistance the data does not support, so it reports the
        // generic token and the control fails it - correctly, for a CUI boundary.
        strongest_factor_type: mfa ? 'totp_or_hardware' : null,
        policy_exemptions: [],
        is_break_glass: false,
        created_at: u.user_creation_time || null,
        last_updated_at: u.password_last_changed && u.password_last_changed !== 'N/A'
          ? u.password_last_changed
          : u.user_creation_time || null,
        // Carried so a reviewer can see that a failing principal also holds long-lived keys, which
        // changes how urgent the finding is.
        active_access_keys: keyCount,
      };
    });
}

/** Shared so fixture and live runs disclose exclusions identically. */
export function reconciliation(report, rows) {
  const excludedNoConsole = report.filter(
    (u) => u.user !== '<root_account>' && String(u.password_enabled ?? '').toLowerCase() !== 'true'
  ).length;
  const parts = ['root account excluded - it is not a workforce identity'];
  if (excludedNoConsole > 0) {
    parts.push(
      `${excludedNoConsole} principal(s) excluded as having no console password (automation, not workforce)`
    );
  }
  return parts.join('; ');
}

async function loadSdk() {
  try {
    return await import('@aws-sdk/client-iam');
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function collect({ config, collectedAt, fixture = false }) {
  if (fixture) {
    const data = JSON.parse(readFileSync(repoPath('fixtures', 'collectors', `${FIXTURE}.json`), 'utf8'));
    const report = parseCredentialReport(data.credential_report_csv);
    const rows = grade({ report, config, collectedAt });
    return {
      table: TABLE,
      rows,
      population: {
        expected: report.length,
        examined: rows.length,
        complete: true,
        reconciliation: reconciliation(report, rows),
        source_of_truth: 'FIXTURE - aws-iam-identities.json, NOT REAL EVIDENCE',
      },
      fixture: true,
    };
  }

  const sdk = await loadSdk();
  if (!sdk) return unavailable('@aws-sdk/client-iam is not installed: npm install @aws-sdk/client-iam');

  const { IAMClient, GenerateCredentialReportCommand, GetCredentialReportCommand } = sdk;
  // IAM is global; the credential report is account-wide regardless of region.
  const client = new IAMClient({ region: config.cloud?.region ?? 'us-east-1' });

  try {
    // The report is generated asynchronously and is cached for four hours. Requesting it and reading
    // whatever is there would silently return a stale one, so generation is driven to COMPLETE.
    let state = (await client.send(new GenerateCredentialReportCommand({}))).State;
    for (let i = 0; state !== 'COMPLETE' && i < 10; i += 1) {
      await sleep(2000);
      state = (await client.send(new GenerateCredentialReportCommand({}))).State;
    }
    if (state !== 'COMPLETE') {
      return unavailable(`credential report did not finish generating (last state ${state})`);
    }

    const res = await client.send(new GetCredentialReportCommand({}));
    const csvText = Buffer.from(res.Content).toString('utf8');
    const report = parseCredentialReport(csvText);
    const rows = grade({ report, config, collectedAt });

    // The report's own timestamp, not the runner's clock. A four-hour-old cached report is still
    // evidence, but it is evidence of four hours ago and the assertion should say so.
    const generatedAt = res.GeneratedTime ? new Date(res.GeneratedTime).toISOString() : null;

    return {
      table: TABLE,
      rows,
      population: {
        expected: report.length,
        examined: rows.length,
        complete: true,
        reconciliation: reconciliation(report, rows),
        source_of_truth: `AWS IAM credential report, generated ${generatedAt ?? 'unknown'}`,
      },
      fixture: false,
    };
  } catch (err) {
    // AccessDenied is not an empty account. Either way the population is unknown, which withholds
    // the control rather than passing it.
    return unavailable(`IAM credential report failed: ${err.name ?? 'Error'} - ${err.message}`);
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
