/**
 * The warehouse landing tables, and the columns each one must have.
 *
 * This is the contract between "some system out there" and every SQL model in models/. It is
 * declared in one place because three different things need it:
 *
 *   1. the warehouse, which creates an EMPTY table for any source nobody collected, so the SQL
 *      always runs no matter how partial the configuration is;
 *   2. the CSV collectors, which map an analyst's export onto these columns and say precisely
 *      which ones are missing rather than failing on a null somewhere downstream;
 *   3. `ccp doctor --templates`, which writes header-only CSV files so the analyst has something
 *      concrete to fill in instead of a schema to interpret.
 *
 * `required` is what a control genuinely cannot be evaluated without. Everything else may be blank,
 * and a blank is carried as unknown rather than being invented.
 */

export const TABLES = {
  src_enclave_idp_users_snapshot: {
    describes: 'Human identities in the enclave identity provider',
    controls: ['ctl.iam.cui-enclave.mfa'],
    required: ['user_id', 'status', 'user_type', 'factor_count'],
    columns: [
      'snapshot_at',
      'user_id',
      'login',
      'status',
      'user_type',
      'factor_count',
      'strongest_factor_type',
      'policy_exemptions',
      'is_break_glass',
      'created_at',
      'last_updated_at',
    ],
  },
  src_corp_idp_users_snapshot: {
    describes: 'Human identities in the corporate identity provider (outside the assessed boundary)',
    controls: ['ctl.iam.corp-it.mfa'],
    required: ['user_id', 'status', 'user_type', 'factor_count'],
    columns: [
      'snapshot_at',
      'user_id',
      'login',
      'status',
      'user_type',
      'factor_count',
      'conditional_access_exempt',
      'last_updated_at',
    ],
  },
  src_cmdb_assets_snapshot: {
    describes: 'Assets the CMDB believes are inside the CUI boundary',
    controls: ['ctl.cui.boundary.asset-inventory'],
    required: ['asset_id'],
    columns: ['snapshot_at', 'asset_id', 'asset_type', 'owner', 'classification', 'in_cui_boundary'],
  },
  src_cloud_resources: {
    describes: 'Resources the cloud provider actually reports in the enclave subscriptions/accounts',
    controls: ['ctl.cui.boundary.asset-inventory'],
    required: ['resource_id'],
    columns: [
      'snapshot_at',
      'resource_id',
      'resource_type',
      'owner_tag',
      'data_classification_tag',
      'subscription_id',
      'location',
    ],
  },
  src_mdm_devices_snapshot: {
    describes: 'Managed endpoints enrolled in the enclave',
    controls: ['ctl.cui.boundary.asset-inventory'],
    required: ['device_id'],
    columns: ['snapshot_at', 'device_id', 'assigned_user', 'enclave_enrolled', 'agent_last_seen'],
  },
  src_procurement_supplier_master: {
    describes: 'Suppliers and subcontractors - the population for BOTH 1260H and 889',
    controls: [
      'ctl.scrm.procurement.entity-list-screening',
      'ctl.scrm.procurement.telecom-equipment-attestation',
    ],
    required: ['supplier_id', 'legal_name', 'relationship_status'],
    columns: [
      'snapshot_at',
      'supplier_id',
      'legal_name',
      'normalised_name',
      'country_of_incorporation',
      'relationship_status',
      'handles_cui',
      'parent_supplier_id',
      'last_screened_at',
    ],
  },
  src_inventory_components: {
    describes: 'Hardware and software components resolved to a manufacturer',
    controls: ['ctl.scrm.procurement.telecom-equipment-attestation'],
    required: ['component_id', 'manufacturer_raw'],
    columns: [
      'snapshot_at',
      'component_id',
      'parent_asset_id',
      'component_type',
      'manufacturer_raw',
      'manufacturer_normalised',
      'manufacturer_resolved',
      'is_substantial_or_essential',
      'source_of_record',
    ],
  },
  src_ir_incidents: {
    describes: 'Incident records, INCLUDING those triaged as not reportable',
    controls: ['ctl.ir.dibnet.incident-reporting'],
    required: ['incident_id', 'discovered_at'],
    columns: [
      'incident_id',
      'opened_at',
      'discovered_at',
      'occurred_at',
      'occurred_at_basis',
      'triage_started_at',
      'affects_covered_contractor_system',
      'affects_cui',
      'reportable_classification',
      'classification_basis',
      'system_image_preserved_until',
      'malware_isolated',
    ],
  },
  src_dibnet_submissions: {
    describes: 'DIBNet submission receipts, keyed back to the incident',
    controls: ['ctl.ir.dibnet.incident-reporting'],
    required: ['incident_id'],
    columns: ['incident_id', 'submitted_at', 'accepted_at', 'report_control_number', 'dc3_malware_submitted_at'],
  },
  src_reference_entity_list_1260h: {
    describes: 'The published Section 1260H list. NOT shipped with this repository - see SETUP.md',
    controls: ['ctl.scrm.procurement.entity-list-screening'],
    required: ['entity_name'],
    columns: [
      'list_published_at',
      'snapshot_ingested_at',
      'entity_name',
      'normalised_name',
      'aliases',
      'parent_entity',
      'listing_authority',
    ],
  },
  src_reference_fasc_orders: {
    describes: 'FASC exclusion and removal orders - a separate statute, the same population question',
    controls: ['ctl.scrm.procurement.entity-list-screening'],
    required: ['entity_name'],
    columns: ['order_issued_at', 'snapshot_ingested_at', 'entity_name', 'normalised_name', 'order_type', 'covered_scope'],
  },
  src_reference_covered_telecom: {
    describes: 'Covered telecommunications manufacturers under Section 889',
    controls: ['ctl.scrm.procurement.telecom-equipment-attestation'],
    required: ['manufacturer_name'],
    columns: [
      'list_published_at',
      'snapshot_ingested_at',
      'manufacturer_name',
      'normalised_name',
      'aliases',
      'covered_category',
    ],
  },
};

/**
 * Landing column types, inferred from the column NAME.
 *
 * Everything-as-VARCHAR is the tempting shortcut and it breaks the models quietly: a timestamp
 * comparison against a string, or `factor_count > 0` on text, either errors or - worse - silently
 * does something else. Names in this schema are consistent enough that one function is both
 * shorter than per-table maps and incapable of drifting out of sync with the column lists.
 */
export function columnType(name) {
  if (name === 'policy_exemptions') return 'VARCHAR[]';
  if (name === 'factor_count') return 'INTEGER';
  if (/_at$|_until$|_seen$/.test(name)) return 'TIMESTAMP';
  if (/^(is_|in_|affects_|handles_)|_exempt$|_resolved$|_enrolled$|_isolated$|_essential$/.test(name)) {
    return 'BOOLEAN';
  }
  return 'VARCHAR';
}

export const tableNames = () => Object.keys(TABLES);

/** Header-only CSV so an analyst has something to fill in rather than a schema to interpret. */
export function csvTemplate(table) {
  const def = TABLES[table];
  if (!def) throw new Error(`unknown table ${table}`);
  return `${def.columns.join(',')}\n`;
}
