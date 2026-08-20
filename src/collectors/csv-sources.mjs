import { existsSync, readFileSync } from 'node:fs';
import { readCsvObjects, csvBool, normaliseEntityName } from './lib/csv.mjs';
import { TABLES } from './tables.mjs';
import { resolvePath } from '../config.mjs';

/**
 * CSV drop collectors - the universal adapter.
 *
 * This is the lowest common denominator on purpose, and it is not a consolation prize. An analyst
 * on day one has no app registration, no service principal and no procurement API, but they can
 * always export a list. That is enough to stand up the Section 1260H and Section 889 controls over
 * a real population, today, and those two are the controls with no API anywhere to automate them
 * against - a supplier master lives in an ERP nobody is going to give you a token for this quarter.
 *
 * A CSV source is a documented manual procedure with a defined cadence, which is legitimate. What
 * is not legitimate is pretending it is continuous, so every CSV collector records the file's
 * modification time as the collection basis and `ccp doctor` reports how stale it is.
 */

/** Turns a missing or empty file into an explicit, non-passing answer rather than an exception. */
function readFile(path) {
  const abs = resolvePath(path);
  if (!abs || !existsSync(abs)) return { ok: false, reason: 'file_not_found', abs };
  const text = readFileSync(abs, 'utf8');
  if (text.trim() === '') return { ok: false, reason: 'file_empty', abs };
  return { ok: true, text, abs };
}

function makeCsvCollector({ name, table, pathKey, map, describes, fixtureFile, caveats }) {
  const def = TABLES[table];

  return {
    VERSION: '1.0.0',
    NAME: name,
    TABLE: table,
    CONTROLS: def.controls,
    DESCRIBES: describes ?? def.describes,
    PATH_KEY: pathKey,

    async collect({ config, collectedAt, fixture = false }) {
      // Fixture mode reads a bundled export rather than the configured path, so a fresh clone
      // runs end to end before anybody has produced a single CSV.
      const path = fixture
        ? 'fixtures/inbox/' + (fixtureFile || name) + '.csv'
        : pathKey.split('.').reduce((o, k) => o?.[k], config);
      const file = readFile(path);

      if (!file.ok) {
        // An absent input is NOT an empty population. Returning zero rows here would make every
        // control over this table pass vacuously, which is the single most dangerous failure a
        // collector can have. The run is marked incomplete and the assertion refuses to pass.
        return {
          table,
          rows: [],
          population: {
            expected: null,
            examined: 0,
            complete: false,
            reconciliation: `${file.reason}: ${path ?? '(no path configured)'} - population unknown, not empty`,
            source_of_truth: path ?? null,
          },
          unavailable: true,
        };
      }

      const { objects, missing, headers } = readCsvObjects(file.text, { required: def.required });
      if (missing.length > 0) {
        return {
          table,
          rows: [],
          population: {
            expected: null,
            examined: 0,
            complete: false,
            reconciliation: `missing required column(s): ${missing.join(', ')}`,
            source_of_truth: file.abs,
          },
          unavailable: true,
        };
      }

      const rows = objects.map((o) => map(o, collectedAt));

      // A scoping column the export omitted is assumed permissive, because an analyst asked for
      // the enclave's assets usually exported the enclave's assets. That assumption decides the
      // DENOMINATOR of the whole CUI-scoped assessment, so it is stated in the assertion record
      // rather than left in this file's source. An enterprise-wide export with no scope column
      // silently makes the entire estate the CUI boundary, and the giveaway is denominator
      // movement - which is exactly the signal AGENTS.md says to alert on.
      const noted = caveats ? caveats(headers) : [];

      return {
        table,
        rows,
        population: {
          expected: rows.length,
          examined: rows.length,
          complete: true,
          ...(noted.length > 0 ? { reconciliation: noted.join(' ') } : {}),
          source_of_truth: file.abs,
        },
        fixture,
      };
    },
  };
}

const iso = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const suppliers = makeCsvCollector({
  name: 'csv-suppliers',
  fixtureFile: 'suppliers',
  table: 'src_procurement_supplier_master',
  pathKey: 'procurement.supplier_master_path',
  map: (o, at) => ({
    snapshot_at: at,
    supplier_id: o.supplier_id,
    legal_name: o.legal_name,
    // Computed here rather than asked for. Expecting an analyst to hand-normalise entity names in a
    // spreadsheet is how screening silently misses a match on a suffix.
    normalised_name: o.normalised_name || normaliseEntityName(o.legal_name),
    country_of_incorporation: o.country_of_incorporation || null,
    relationship_status: (o.relationship_status || 'active').toLowerCase(),
    handles_cui: csvBool(o.handles_cui),
    parent_supplier_id: o.parent_supplier_id || null,
    last_screened_at: iso(o.last_screened_at),
  }),
});

export const components = makeCsvCollector({
  name: 'csv-components',
  fixtureFile: 'components',
  table: 'src_inventory_components',
  pathKey: 'inventory.components_path',
  map: (o, at) => {
    const raw = o.manufacturer_raw || '';
    return {
      snapshot_at: at,
      component_id: o.component_id,
      parent_asset_id: o.parent_asset_id || null,
      component_type: o.component_type || null,
      manufacturer_raw: raw,
      manufacturer_normalised: o.manufacturer_normalised || normaliseEntityName(raw),
      // Blank manufacturer means UNRESOLVED, which the control fails on. It does not mean clean.
      manufacturer_resolved: o.manufacturer_resolved ? csvBool(o.manufacturer_resolved) : raw.trim() !== '',
      is_substantial_or_essential: o.is_substantial_or_essential ? csvBool(o.is_substantial_or_essential) : true,
      source_of_record: o.source_of_record || 'csv',
    };
  },
});

export const incidents = makeCsvCollector({
  name: 'csv-incidents',
  fixtureFile: 'incidents',
  table: 'src_ir_incidents',
  pathKey: 'incident_response.incidents_path',
  map: (o) => ({
    incident_id: o.incident_id,
    opened_at: iso(o.opened_at),
    discovered_at: iso(o.discovered_at),
    occurred_at: iso(o.occurred_at),
    // If nobody recorded how onset was established, it was not established. Defaulting to
    // equals_detected understates duration, and saying so is the whole point of the field.
    occurred_at_basis: o.occurred_at_basis || (o.occurred_at ? 'source_system' : 'equals_detected'),
    triage_started_at: iso(o.triage_started_at),
    affects_covered_contractor_system: csvBool(o.affects_covered_contractor_system),
    affects_cui: csvBool(o.affects_cui),
    reportable_classification: o.reportable_classification || 'unclassified',
    classification_basis: o.classification_basis || null,
    system_image_preserved_until: iso(o.system_image_preserved_until),
    malware_isolated: csvBool(o.malware_isolated),
  }),
});

export const submissions = makeCsvCollector({
  name: 'csv-dibnet-submissions',
  fixtureFile: 'dibnet-submissions',
  table: 'src_dibnet_submissions',
  pathKey: 'incident_response.submissions_path',
  map: (o) => ({
    incident_id: o.incident_id,
    submitted_at: iso(o.submitted_at),
    accepted_at: iso(o.accepted_at),
    report_control_number: o.report_control_number || null,
    dc3_malware_submitted_at: iso(o.dc3_malware_submitted_at),
  }),
});

export const identities = makeCsvCollector({
  name: 'csv-identities',
  fixtureFile: 'identities',
  table: 'src_enclave_idp_users_snapshot',
  pathKey: 'identity.csv_path',
  map: (o, at) => ({
    snapshot_at: at,
    user_id: o.user_id,
    login: o.login || null,
    status: (o.status || 'active').toLowerCase(),
    user_type: (o.user_type || 'human').toLowerCase(),
    factor_count: Number(o.factor_count || 0),
    strongest_factor_type: o.strongest_factor_type || null,
    policy_exemptions: o.policy_exemptions ? o.policy_exemptions.split('|').filter(Boolean) : [],
    is_break_glass: csvBool(o.is_break_glass),
    created_at: iso(o.created_at),
    last_updated_at: iso(o.last_updated_at),
  }),
});

/**
 * The CMDB half of the asset reconciliation - what the organisation BELIEVES is in the boundary.
 *
 * This is its own configured source, not a variant of the cloud one, and the distinction is the
 * whole control. Reconciliation needs two independently-sourced opinions about the same estate:
 * what the CMDB claims, and what the cloud actually reports. Wiring both to one config slot makes
 * them mutually exclusive, and a control that can only ever see one side cannot reconcile
 * anything - it just restates its single source and calls the difference a finding.
 *
 * Concretely, with only this side loaded every asset reads as managed and the unmanaged-asset
 * finding can never fire; with only the cloud side loaded every asset reads as absent from the
 * CMDB, which is what a live run against the lab account produced - 82 of 82 failing for one
 * reason, at full confidence, saying nothing.
 */
export const cmdbAssets = makeCsvCollector({
  name: 'csv-cmdb-assets',
  fixtureFile: 'cmdb-assets',
  table: 'src_cmdb_assets_snapshot',
  pathKey: 'cmdb.assets_path',
  caveats: (headers) =>
    headers.includes('in_cui_boundary')
      ? []
      : [
          'Export carried no in_cui_boundary column, so every row was taken as in-boundary. ' +
            'If this was an enterprise-wide extract, the CUI denominator is the whole estate.',
        ],
  map: (o, at) => ({
    snapshot_at: at,
    asset_id: o.asset_id,
    asset_type: o.asset_type || null,
    owner: o.owner || null,
    classification: o.classification || null,
    in_cui_boundary: o.in_cui_boundary ? csvBool(o.in_cui_boundary) : true,
  }),
});

/**
 * The cloud half, for an estate with no reachable cloud API - an export from the console, or a
 * provider this repository has no collector for. It lands in the same table the Azure and AWS
 * collectors write, so the models stay provider-neutral.
 */
export const cloudResources = makeCsvCollector({
  name: 'csv-cloud-resources',
  fixtureFile: 'cloud-resources',
  table: 'src_cloud_resources',
  pathKey: 'cloud.csv_path',
  map: (o, at) => ({
    snapshot_at: at,
    resource_id: o.resource_id,
    resource_type: o.resource_type || null,
    owner_tag: o.owner_tag || null,
    data_classification_tag: o.data_classification_tag || null,
    subscription_id: o.subscription_id || null,
    location: o.location || null,
  }),
});

/**
 * Managed endpoints - the third leg. Laptops are where CUI actually gets opened, and they appear
 * in neither the CMDB nor the cloud API, so without this source the boundary inventory is missing
 * the asset class most likely to hold a CUI document.
 */
export const mdmDevices = makeCsvCollector({
  name: 'csv-mdm-devices',
  fixtureFile: 'mdm-devices',
  table: 'src_mdm_devices_snapshot',
  pathKey: 'mdm.devices_path',
  caveats: (headers) =>
    headers.includes('enclave_enrolled')
      ? []
      : [
          'Export carried no enclave_enrolled column, so every device was taken as enclave-enrolled.',
        ],
  map: (o, at) => ({
    snapshot_at: at,
    device_id: o.device_id,
    assigned_user: o.assigned_user || null,
    // Absent column means the analyst exported the enclave's enrolment list, which is what was
    // asked for. A blank VALUE in a present column is still unknown and stays excluded.
    enclave_enrolled: o.enclave_enrolled ? csvBool(o.enclave_enrolled) : true,
    agent_last_seen: iso(o.agent_last_seen),
  }),
});

export const entityList1260h = makeCsvCollector({
  name: 'reference-1260h',
  fixtureFile: 'entity-list-1260h',
  table: 'src_reference_entity_list_1260h',
  pathKey: 'reference.entity_list_1260h_path',
  map: (o, at) => ({
    list_published_at: iso(o.list_published_at) ?? at,
    snapshot_ingested_at: at,
    entity_name: o.entity_name,
    normalised_name: o.normalised_name || normaliseEntityName(o.entity_name),
    aliases: o.aliases || null,
    parent_entity: o.parent_entity || null,
    listing_authority: o.listing_authority || 'FY2021 NDAA 1260H',
  }),
});

export const fascOrders = makeCsvCollector({
  name: 'reference-fasc',
  fixtureFile: 'fasc-orders',
  table: 'src_reference_fasc_orders',
  pathKey: 'reference.fasc_orders_path',
  map: (o, at) => ({
    order_issued_at: iso(o.order_issued_at) ?? at,
    snapshot_ingested_at: at,
    entity_name: o.entity_name,
    normalised_name: o.normalised_name || normaliseEntityName(o.entity_name),
    order_type: o.order_type || 'exclusion',
    covered_scope: o.covered_scope || null,
  }),
});

export const coveredTelecom = makeCsvCollector({
  name: 'reference-covered-telecom',
  fixtureFile: 'covered-telecom',
  table: 'src_reference_covered_telecom',
  pathKey: 'reference.covered_telecom_path',
  map: (o, at) => ({
    list_published_at: iso(o.list_published_at) ?? at,
    snapshot_ingested_at: at,
    manufacturer_name: o.manufacturer_name,
    normalised_name: o.normalised_name || normaliseEntityName(o.manufacturer_name),
    aliases: o.aliases || null,
    covered_category: o.covered_category || 'telecommunications',
  }),
});
