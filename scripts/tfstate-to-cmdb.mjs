#!/usr/bin/env node
// Terraform state -> a CMDB export the asset-inventory control can reconcile against.
//
// WHY TERRAFORM STATE IS A LEGITIMATE CMDB, and a cloud API is not.
//
// `ctl.cui.boundary.asset-inventory` is a RECONCILIATION: it compares what you believe you have
// against what the cloud actually reports, and its value is entirely in the disagreement. Generate
// the "CMDB" half from the same API that supplies the other half and the control compares a source
// to itself - a tautology that passes 100% forever while measuring nothing.
//
// Terraform state is genuinely independent: it is what was DECLARED, against what EXISTS. A resource
// in the cloud but absent from state is unmanaged drift, which is exactly the finding the control is
// for.
//
// SECRETS. A tfstate routinely carries plaintext credentials in resource attributes - database
// passwords, access keys, private keys. This reads ONLY identity fields (type, name, id, arn) and
// never touches the rest of the attribute bag, so nothing sensitive can reach the CSV. Keep the raw
// state out of the repository; it is not gitignore-able by accident.
//
//   node scripts/tfstate-to-cmdb.mjs <terraform.tfstate> <out.csv> [--owner <name>]
//
// --owner names who owns resources in the ROOT module. Resources inside a module take the module
// name instead. It matters because `owner` is what routes a finding to a person, and a default of
// "terraform" routes to nobody.
//
// Typically:
//   aws s3 cp s3://<tfstate-bucket>/<key>/terraform.tfstate /tmp/state.json
//   node scripts/tfstate-to-cmdb.mjs /tmp/state.json inbox/cmdb-assets.csv
//   rm /tmp/state.json

import { readFileSync, writeFileSync } from 'node:fs';

/** Identity fields only. Never the attribute bag. */
export function extractAssets(state, { defaultOwner = 'terraform' } = {}) {
  const rows = [];
  const seen = new Set();

  for (const resource of state.resources ?? []) {
    // Data sources describe what Terraform READS, not what it manages. Including them would claim
    // ownership of infrastructure somebody else provisioned - the opposite of what a CMDB asserts.
    if (resource.mode !== 'managed') continue;
    if (!String(resource.type ?? '').startsWith('aws_')) continue;

    for (const instance of resource.instances ?? []) {
      const attrs = instance.attributes ?? {};
      const id = attrs.id ?? null;
      const arn = attrs.arn ?? null;
      if (!id && !arn) continue;

      const assetId = id ?? arn;
      if (seen.has(assetId)) continue;
      seen.add(assetId);

      rows.push({
        asset_id: assetId,
        asset_type: resource.type,
        owner: resource.module ? resource.module.replace(/^module\./, '') : defaultOwner,
        // Left BLANK deliberately. State says what exists, not how the data is classified. Filling
        // it in would invent a classification nobody assigned, and the control would pass on it.
        classification: '',
        in_cui_boundary: 'true',
      });
    }
  }

  return rows.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
}

const COLUMNS = ['asset_id', 'asset_type', 'owner', 'classification', 'in_cui_boundary'];

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

/**
 * A crude last line of defence. The extractor cannot leak an attribute value by construction, but a
 * future edit could, and a credential reaching a CSV that gets uploaded is not a mistake you get to
 * take back. Resource NAMES legitimately contain these words, so this checks values rather than
 * substrings - anything long and high-entropy in a field that should hold an identifier.
 */
export function suspectSecrets(rows) {
  const suspicious = [];
  for (const r of rows) {
    for (const c of COLUMNS) {
      const v = String(r[c] ?? '');
      // Identifiers are structured: they contain separators. A long unbroken base64-ish run is not.
      if (v.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(v)) {
        suspicious.push(`${r.asset_id}: ${c} looks like an opaque token`);
      }
    }
  }
  return suspicious;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const [statePath, outPath] = args;
  const ownerIdx = process.argv.indexOf('--owner');
  const defaultOwner = ownerIdx === -1 ? 'terraform' : process.argv[ownerIdx + 1];

  if (!statePath || !outPath) {
    console.error('usage: node scripts/tfstate-to-cmdb.mjs <terraform.tfstate> <out.csv> [--owner <name>]');
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const rows = extractAssets(state, { defaultOwner });

  const suspicious = suspectSecrets(rows);
  if (suspicious.length > 0) {
    console.error('refusing to write - possible credential material in the output:');
    for (const s of suspicious) console.error(`  ${s}`);
    process.exit(2);
  }

  writeFileSync(outPath, toCsv(rows));

  const byType = {};
  for (const r of rows) byType[r.asset_type] = (byType[r.asset_type] ?? 0) + 1;
  console.log(`wrote ${rows.length} managed resource(s) across ${Object.keys(byType).length} type(s) to ${outPath}`);
  console.log('classification is blank by design - state says what exists, not how it is classified');
}
