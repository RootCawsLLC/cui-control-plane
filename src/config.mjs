import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

import { ROOT, loadSchema } from './lib/load.mjs';

export const CONFIG_FILE = 'ccp.config.yaml';

/**
 * Loads and validates ccp.config.yaml - the one file an organisation edits.
 *
 * CREDENTIALS ARE NEVER READ FROM THIS FILE. Every secret comes from an environment variable,
 * named here so the config is self-describing and committable. The moment a client secret can
 * live in a YAML file, somebody commits one.
 */

/** Environment variables each provider needs. Named in one place so `ccp doctor` can check them. */
export const REQUIRED_ENV = {
  entra: ['CCP_ENTRA_TENANT_ID', 'CCP_ENTRA_CLIENT_ID', 'CCP_ENTRA_CLIENT_SECRET'],
  okta: ['CCP_OKTA_ORG_URL', 'CCP_OKTA_API_TOKEN'],
  azure: ['CCP_AZURE_TENANT_ID', 'CCP_AZURE_CLIENT_ID', 'CCP_AZURE_CLIENT_SECRET'],
  'azure-gov': ['CCP_AZURE_TENANT_ID', 'CCP_AZURE_CLIENT_ID', 'CCP_AZURE_CLIENT_SECRET'],
  'aws-govcloud': [],
  csv: [],
  none: [],
};

/**
 * Methods that count as phishing-resistant unless the organisation says otherwise.
 *
 * Deliberately excludes SMS, voice and authenticator push - those are multi-factor but not
 * phishing-resistant, and 800-171 3.5.3 is assessed on multi-factor while the CUI threat model
 * cares about the stronger property. The control asserts the stronger one; a company that has not
 * got there yet should widen this list AND know that it has.
 */
/**
 * Okta names the same factors differently, so the default has to follow the provider. Carrying
 * Entra's vocabulary into an Okta deployment would quietly mark every phishing-resistant factor as
 * not resistant, and the control would fail everyone for the wrong reason.
 */
export const DEFAULT_PHISHING_RESISTANT_OKTA = [
  'webauthn',
  'u2f',
  'signed_nonce',
];

export const DEFAULT_PHISHING_RESISTANT = [
  'fido2SecurityKey',
  'passKeyDeviceBound',
  'passKeyDeviceBoundAuthenticator',
  'windowsHelloForBusiness',
  'x509Certificate',
];

let compiled = null;
function validator() {
  if (compiled) return compiled;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = ajv.compile(loadSchema('config.schema.json'));
  return compiled;
}

export const configPath = (file = CONFIG_FILE) => resolve(ROOT, file);

export const configExists = (file = CONFIG_FILE) => existsSync(configPath(file));

export class ConfigError extends Error {}

export const EXAMPLE_CONFIG = 'examples/ccp.config.example.yaml';

/**
 * Loads the organisation's config, falling back to the bundled example.
 *
 * The fallback is what makes a fresh clone runnable: `npm install && npm run pipeline` works before
 * anybody has answered a single question. The example is wired entirely to bundled fixtures, so it
 * cannot accidentally read from, or assert against, a real system.
 *
 * ccp.config.yaml is gitignored on purpose. It describes one organisation's boundary and systems,
 * and it should live in that organisation's own repository rather than being carried back upstream.
 */
export function loadConfig(file = CONFIG_FILE) {
  let path = configPath(file);
  let usingExample = false;

  if (!existsSync(path)) {
    path = configPath(EXAMPLE_CONFIG);
    usingExample = true;
    if (!existsSync(path)) {
      throw new ConfigError(
        `no ${file} and no ${EXAMPLE_CONFIG}. Run \`npm run init\` to create a config.`
      );
    }
  }

  const config = parse(readFileSync(path, 'utf8'));
  const validate = validator();
  if (!validate(config)) {
    const detail = validate.errors
      .map((e) => `  ${e.instancePath || '/'} ${e.message}`)
      .join('\n');
    throw new ConfigError(`${file} is not valid:\n${detail}`);
  }
  return { ...withDefaults(config), _usingExample: usingExample, _path: path };
}

function withDefaults(config) {
  return {
    ...config,
    identity: {
      cloud_environment: 'commercial',
      exclude_guests: true,
      phishing_resistant_methods:
        config.identity?.phishing_resistant_methods ??
        (config.identity?.provider === 'okta' ? DEFAULT_PHISHING_RESISTANT_OKTA : DEFAULT_PHISHING_RESISTANT),
      ...config.identity,
    },
    reference: {
      covered_telecom_path: 'reference/covered-telecom.seed.csv',
      ...config.reference,
    },
    cloud: {
      // Tag keys are an organisational convention. Hardcoding them made a live run report 82 of 82
      // resources unowned against an account that tags everything - just not with these words.
      owner_tag: 'owner',
      classification_tag: 'data_classification',
      ...config.cloud,
    },
    warehouse: { path: '.warehouse/ccp.duckdb', ...config.warehouse },
    evidence: { path: '.evidence', retain_days: 400, ...config.evidence },
  };
}

/**
 * Microsoft endpoints differ for government tenants, and this is the single most common reason
 * working commercial code returns 401 against a GCC High tenant. Kept in one place so no collector
 * hard-codes graph.microsoft.com.
 */
export function graphEndpoints(cloudEnvironment) {
  return cloudEnvironment === 'usgov'
    ? { login: 'https://login.microsoftonline.us', graph: 'https://graph.microsoft.us', arm: 'https://management.usgovcloudapi.net' }
    : { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com', arm: 'https://management.azure.com' };
}

/** Which env vars are missing for a given provider. Empty array means ready. */
export function missingEnv(provider, env = process.env) {
  return (REQUIRED_ENV[provider] ?? []).filter((k) => !env[k]);
}

export const resolvePath = (p) => (p ? resolve(ROOT, p) : null);
export const repoPath = (...parts) => join(ROOT, ...parts);
