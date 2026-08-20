import * as entra from './entra-identities.mjs';
import * as azure from './azure-assets.mjs';
import * as okta from './okta-identities.mjs';
import * as aws from './aws-assets.mjs';
import * as csv from './csv-sources.mjs';

/**
 * Which collector runs, given the configuration.
 *
 * Selection is explicit rather than "try everything and see what works". A collector that runs
 * because a credential happened to be present is a population nobody chose, and the boundary is
 * exactly the thing that must not expand by accident.
 *
 * Adding a provider is a new module plus one line here. The contract is:
 *   NAME, TABLE, CONTROLS, collect({ config, collectedAt, fixture }) -> { table, rows, population }
 * with grading exported pure and separate from fetching, so it is testable without credentials.
 */

const wrap = (mod, name) => ({
  name,
  table: mod.TABLE,
  controls: mod.CONTROLS,
  collect: mod.collect,
});

/** Same contract, for the CSV collectors, which carry their own NAME rather than being passed one. */
const pick = (c) => ({ name: c.NAME, table: c.TABLE, controls: c.CONTROLS, collect: c.collect });

export function selectCollectors(config) {
  const chosen = [];
  const skipped = [];

  // --- identity ------------------------------------------------------------------------------
  switch (config.identity?.provider) {
    case 'entra':
      chosen.push(wrap(entra, 'entra-identities'));
      break;
    case 'csv':
      chosen.push(pick(csv.identities));
      break;
    case 'okta':
      chosen.push(wrap(okta, 'okta-identities'));
      break;
    default:
      skipped.push({ name: 'identity', reason: 'identity.provider is none - the MFA control has no population' });
  }

  // --- cloud / assets ------------------------------------------------------------------------
  switch (config.cloud?.provider) {
    case 'azure':
    case 'azure-gov':
      chosen.push(wrap(azure, 'azure-assets'));
      break;
    case 'csv':
      chosen.push(pick(csv.cloudResources));
      break;
    case 'aws-govcloud':
      chosen.push(wrap(aws, 'aws-assets'));
      break;
    default:
      skipped.push({ name: 'cloud', reason: 'cloud.provider is none - the asset inventory has no cloud half' });
  }

  // --- CMDB ----------------------------------------------------------------------------------
  // Deliberately its own setting rather than a mode of cloud.provider. The asset control
  // reconciles what the CMDB claims against what the cloud reports; tying both to one setting
  // makes the two halves mutually exclusive, and neither half alone reconciles anything.
  if (config.cmdb?.source === 'csv') {
    chosen.push(pick(csv.cmdbAssets));
  } else {
    skipped.push({
      name: 'csv-cmdb-assets',
      reason: 'cmdb.source is none - no CMDB half, so every cloud asset reads as absent from it',
    });
  }

  // --- managed endpoints ---------------------------------------------------------------------
  if (config.mdm?.source === 'csv') {
    chosen.push(pick(csv.mdmDevices));
  } else {
    skipped.push({
      name: 'csv-mdm-devices',
      reason: 'mdm.source is none - managed endpoints are absent from the boundary inventory',
    });
  }

  // --- flat-file sources ---------------------------------------------------------------------
  const fileSources = [
    [config.procurement?.source === 'csv', csv.suppliers],
    [config.inventory?.source === 'csv', csv.components],
    [config.incident_response?.source === 'csv', csv.incidents],
    [config.incident_response?.source === 'csv', csv.submissions],
    [Boolean(config.reference?.entity_list_1260h_path), csv.entityList1260h],
    [Boolean(config.reference?.fasc_orders_path), csv.fascOrders],
    [Boolean(config.reference?.covered_telecom_path), csv.coveredTelecom],
  ];

  for (const [enabled, c] of fileSources) {
    if (enabled) {
      chosen.push(pick(c));
    } else {
      skipped.push({ name: c.NAME, reason: 'not configured' });
    }
  }

  return { chosen, skipped };
}

/** Every collector, regardless of config - used by `ccp doctor --templates` and by tests. */
export const ALL = {
  entra,
  azure,
  okta,
  aws,
  ...csv,
};
