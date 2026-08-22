import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import { ROOT, loadSchema } from './lib/load.mjs';

/**
 * Attestations - evidence for controls that genuinely have no query behind them.
 *
 * THE CASE FOR ALLOWING THIS AT ALL. Without it, every control whose system exposes no API sits
 * withheld forever and the inventory silently narrows to whatever happens to have a REST endpoint.
 * AWS Identity Center publishes no per-user MFA state through any public API - verified against the
 * SDK, not assumed - so `ctl.iam.cui-enclave.mfa` cannot be queried at all in a federated account.
 * A documented manual procedure on a defined cadence is legitimate evidence.
 *
 * THE CASE FOR CONSTRAINING IT HARD. An attestation that looks like telemetry is worse than no
 * attestation, because the whole value of this pipeline is that a reader can tell how a number was
 * obtained. So:
 *
 *   - tier is CAPPED at 2, and at 1 for a sample. A query earns 4; nothing manual ever does.
 *   - expiry is mandatory and enforced. Past it the control is WITHHELD, not failed - the claim went
 *     stale, which is not the same as the control breaking.
 *   - `source_kind: attested` rides on the assertion, so every downstream artifact can distinguish
 *     it without re-deriving anything.
 *   - `why_no_query` is required, so an attestation is a considered choice rather than the easy
 *     path. "The vendor exposes no API" is a reason. "We have not built the collector" is a backlog
 *     item pretending to be one.
 */

export const ATTESTATION_DIR = 'attestations';

/** Manual evidence never reaches the tier a reproducible query earns. */
export const TIER_BY_METHOD = {
  'console-review': 2,
  'vendor-report': 2,
  'process-walkthrough': 2,
  // A sample is not a population. This repository refuses sampling everywhere else; where a sample
  // is genuinely all that exists, it is admitted at the lowest tier and labelled.
  'sampled-inspection': 1,
};

let compiled = null;
function validator() {
  if (compiled) return compiled;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = ajv.compile(loadSchema('attestation.schema.json'));
  return compiled;
}

/**
 * Org-unit words that mean nobody actually signed this.
 *
 * DELIBERATELY A BLOCKLIST OF UNIT WORDS, not a heuristic about what a name looks like. The tempting
 * version - require two capitalised tokens, or reject anything without a space - rejects mononyms,
 * names in non-Latin scripts, hyphenated and particled surnames, and plenty of ordinary names. That
 * would be both wrong and insulting, and it would fail in the unsafe direction by rejecting real
 * attesters. Matching a small set of words that are never part of a personal name is narrower and
 * fails safely: an unusual real name passes, and only "IT Ops" is refused.
 *
 * Word-boundary matched, so a surname that merely contains these letters is unaffected.
 */
const UNIT_WORDS =
  /\b(team|teams|group|dept|department|ops|secops|devops|sre|admin|admins|administrator|security|compliance|platform|tbd|unknown|none|various|n\/?a)\b/i;

export function loadAttestations(dir = ATTESTATION_DIR) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];

  return readdirSync(abs)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => ({ file: f, doc: parse(readFileSync(join(abs, f), 'utf8')) }));
}

/**
 * Validates one attestation against schema plus the rules a schema cannot express.
 * Returns { ok, errors[] } rather than throwing - the caller decides whether a bad attestation is
 * fatal or simply means the control stays withheld.
 */
export function validateAttestation(doc, { controls = [], now = new Date() } = {}) {
  const errors = [];
  const validate = validator();

  if (!validate(doc)) {
    for (const e of validate.errors) errors.push(`${e.instancePath || '/'} ${e.message}`);
    return { ok: false, errors, expired: false };
  }

  // A named human, not a role. "The security team attests" is nobody attesting.
  if (UNIT_WORDS.test(doc.attested_by.trim())) {
    errors.push(`attested_by "${doc.attested_by}" is a role or placeholder - an attestation needs a person's name`);
  }

  if (doc.passing_count + doc.failing.length !== doc.total) {
    errors.push(
      `counts do not reconcile: passing_count ${doc.passing_count} + ${doc.failing.length} failing != total ${doc.total}`
    );
  }

  const attestedAt = new Date(doc.attested_at);
  const expiresAt = new Date(doc.expires_at);
  if (expiresAt <= attestedAt) {
    errors.push('expires_at must be after attested_at');
  }

  // A five-year attestation is an unexpiring one wearing a costume.
  const days = (expiresAt - attestedAt) / 86400000;
  if (days > 400) {
    errors.push(`validity of ${Math.round(days)} days is too long - an attestation older than a year is a claim nobody has rechecked`);
  }

  const control = controls.find((c) => c.control_id === doc.control_id);
  if (controls.length > 0 && !control) {
    errors.push(`no control record for ${doc.control_id}`);
  }

  // Same drift rule as query_ref. An attestation about a different population than the control
  // defines is not evidence for that control.
  if (control) {
    const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm(control.population_definition) !== norm(doc.population_definition)) {
      errors.push('population_definition does not match the control record - attested population drift');
    }
  }

  const expired = expiresAt < now;
  return { ok: errors.length === 0, errors, expired, expiresAt };
}

/**
 * Turns a valid, unexpired attestation into a canonical assertion record.
 *
 * An expired one returns null and the caller withholds. That distinction matters: a stale claim is
 * not a failing control, and reporting it as failing would send somebody to fix something that may
 * be perfectly fine.
 */
export function assertionFromAttestation(doc, { asOf, now = new Date() }) {
  if (new Date(doc.expires_at) < now) return null;

  return {
    control_id: doc.control_id,
    as_of: asOf,
    population_definition: doc.population_definition.trim().replace(/\s+/g, ' '),
    source_system: `attestation by ${doc.attested_by} (${doc.role})`,
    query_ref: `${ATTESTATION_DIR}/${doc.control_id}.yaml`,
    total: doc.total,
    passing_count: doc.passing_count,
    failing_count: doc.failing.length,
    failing: doc.failing.map((f) => ({
      subject_id: f.subject_id,
      reason: f.reason,
      first_observed: f.first_observed ?? `${doc.attested_at}T00:00:00Z`,
      variance: {
        variance_started_at: null,
        variance_detected_at: `${doc.attested_at}T00:00:00Z`,
        remediation_started_at: null,
        remediation_completed_at: null,
        // An attestation cannot establish onset - the attester saw a state, not a transition.
        started_at_basis: 'equals_detected',
      },
    })),
    passing: null,
    coverage_basis: [
      `ATTESTED, not queried. ${doc.statement}`,
      `Basis: ${doc.basis}`,
      `Method: ${doc.method}. Attested ${doc.attested_at} by ${doc.attested_by} (${doc.role}), expires ${doc.expires_at}.`,
      doc.why_no_query ? `No query because: ${doc.why_no_query}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    confidence_tier: TIER_BY_METHOD[doc.method] ?? 1,
    // The load-bearing field. Everything downstream can tell this apart from telemetry without
    // re-deriving anything, and no report has to guess.
    source_kind: 'attested',
  };
}

export function formatAttestations({ loaded, valid, expired, invalid }) {
  const out = ['Attestations - manual evidence for controls with no query behind them', ''];
  if (loaded === 0) {
    out.push('  none. Controls with no collector stay withheld, which is correct until somebody attests.');
    return out.join('\n');
  }
  out.push(`  ${loaded} loaded: ${valid.length} usable, ${expired.length} expired, ${invalid.length} invalid`);
  for (const a of valid) out.push(`    ok       ${a.control_id.padEnd(46)} expires ${a.expires_at}`);
  for (const a of expired) {
    out.push(`    EXPIRED  ${a.control_id.padEnd(46)} expired ${a.expires_at} - control WITHHELD, not failed`);
  }
  for (const a of invalid) out.push(`    INVALID  ${a.file}: ${a.errors[0]}`);
  return out.join('\n');
}
