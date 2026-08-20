#!/usr/bin/env node
/**
 * Resolves crosswalk edges from a locally-obtained Secure Controls Framework release.
 *
 * SCF IS NEVER VENDORED HERE. Its CC BY-ND licence names AI-generated derivative content
 * specifically, and redistributing a transformed copy is exactly what that forbids. What is
 * legitimate - and what this does - is to read a release you obtained yourself, resolve OUR control
 * IDs to SCF identifiers, and record the resulting edges as identifiers plus our own reasoning.
 * See docs/adr/0006-no-framework-text.md.
 *
 * Obtain a release from securecontrolsframework.com and drop the OSCAL JSON at:
 *
 *     reference/scf/scf-oscal.json          (gitignored)
 *
 * Then:  node scripts/import-scf.mjs --dry-run
 *
 * WHY THIS MATTERS BEYOND TIDINESS: SCF's crosswalk set already includes 800-171, SOC 2, ISO 27001,
 * NIST 800-53 and CSF. Map a control to SCF once and the rest are inherited rather than maintained
 * as N bilateral mappings. Since 2024 those crosswalks use NIST IR 8477 Set Theory Relationship
 * Mapping - typed relationships with strength scores, not just "related" - and the relationship
 * TYPE is preserved, because a subset mapping and an equal mapping mean different things when you
 * are building a Statement of Applicability.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadControls } from '../src/lib/load.mjs';

const SCF_PATH = join(ROOT, 'reference', 'scf', 'scf-oscal.json');

function main(argv) {
  const dryRun = argv.includes('--dry-run');

  if (!existsSync(SCF_PATH)) {
    console.error(
      `no SCF release found at reference/scf/scf-oscal.json\n\n` +
        'This repository does not and will not vendor SCF content - CC BY-ND forbids publishing\n' +
        'derivative content, and names AI-generated derivatives specifically. Obtain a release from\n' +
        'securecontrolsframework.com, place the OSCAL JSON at that path (it is gitignored), and\n' +
        're-run.\n\n' +
        'Until then, SCF edges on control records stay at confidence: medium with\n' +
        'inherited_via_scf absent, which is the honest state: the identifier is carried from a\n' +
        'reference example, not from the authority.'
    );
    return 1;
  }

  const scf = JSON.parse(readFileSync(SCF_PATH, 'utf8'));
  const known = new Set(collectControlIds(scf));
  const controls = loadControls();

  let checked = 0;
  let unknown = 0;

  for (const c of controls) {
    for (const edge of c.crosswalk ?? []) {
      if (edge.framework !== 'scf') continue;
      checked += 1;
      if (!known.has(edge.reference)) {
        unknown += 1;
        console.error(
          `${c._file}: SCF ${edge.reference} is not present in this release. Either the identifier ` +
            'is wrong or the release predates it - do not "fix" it by widening the match.'
        );
      } else if (edge.confidence !== 'high') {
        console.log(
          `${c._file}: SCF ${edge.reference} resolved against the release. Promote confidence to ` +
            'high and set inherited_via_scf on any edges you derive from its crosswalk set.'
        );
      }
    }
  }

  console.log(`\n${checked} SCF edge(s) checked, ${unknown} unresolved.`);
  if (dryRun) console.log('dry run - no records were modified.');
  return unknown > 0 ? 1 : 0;
}

/** SCF ships as an OSCAL catalog; walk groups and controls for identifiers. */
function collectControlIds(doc) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string' && Array.isArray(node.parts)) out.push(node.id.toUpperCase());
    for (const key of ['groups', 'controls']) if (node[key]) walk(node[key]);
    if (node.catalog) walk(node.catalog);
  };
  walk(doc);
  return out;
}

process.exit(main(process.argv.slice(2)));
