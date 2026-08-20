#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, loadAssertions, latestPerControl, isFixtureSet, FIXTURE_STAMP } from './lib/load.mjs';
import { validate } from './validate.mjs';
import { coverage, formatCoverage } from './coverage.mjs';
import { score, formatScore, UnverifiedWeights } from './sprs.mjs';
import { variance, formatVariance } from './variance.mjs';
import { serialize } from './oscal/common.mjs';
import { catalog, profiles } from './oscal/catalog.mjs';
import { componentDefinition } from './oscal/component-definition.mjs';
import { assessmentResults } from './oscal/assessment-results.mjs';
import { poam } from './oscal/poam.mjs';
import { ssp } from './oscal/ssp.mjs';
import { assessmentPlan } from './oscal/assessment-plan.mjs';

const USAGE = `ccp - CUI control plane

  ccp validate                    schema + house rules over controls/ and models/
  ccp coverage                    which of the 110 requirements have a control
  ccp sprs      [--assertions D] [--weights F]   derive the SPRS score
  ccp variance  [--assertions D]                 VF/VD per control, from assertion history
  ccp emit all  [--assertions D] [--out D]       OSCAL O1-O5

House rules enforced by validate: assertions quantify over a population; query_ref exists and
matches its record; a layer split states its rationale; policy_ref requires an operating control;
every control model reaches the variance layer.
`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

function main(argv) {
  const [command, sub] = argv;

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'validate') {
    const { errors, warnings, controlCount, scenarioCount, exceptionCount } = validate();
    for (const w of warnings) console.warn(`warn  ${w}`);
    for (const e of errors) console.error(`error ${e}`);
    if (errors.length > 0) {
      console.error(`\n${errors.length} error(s) across ${controlCount} control(s).`);
      return 1;
    }
    console.log(
      `ok: ${controlCount} control(s), ${scenarioCount} scenario(s), ${exceptionCount} exception(s), ` +
        `${warnings.length} warning(s).`
    );
    return 0;
  }

  if (command === 'coverage') {
    console.log(formatCoverage(coverage()));
    return 0;
  }

  if (command === 'variance') {
    const assertions = loadAssertions(arg(argv, 'assertions', 'fixtures/assertions'));
    console.log(formatVariance(variance(assertions)));
    return 0;
  }

  if (command === 'sprs') {
    const assertions = loadAssertions(arg(argv, 'assertions', 'fixtures/assertions'));
    const weightsPath = arg(argv, 'weights', 'reference/sprs-weights.yaml');
    try {
      console.log(formatScore(score({ assertions, weightsPath })));
      return 0;
    } catch (err) {
      if (err instanceof UnverifiedWeights) {
        console.error(err.message);
        return 2;
      }
      throw err;
    }
  }

  if (command === 'emit') {
    if (sub !== 'all') {
      console.error('only `ccp emit all` is supported - the OSCAL models are generated as a set, ' +
        'because a package with some models regenerated and others stale is worse than no package.');
      return 1;
    }
    // Point-in-time package: the newest assertion per control. The full history drives
    // `ccp variance` instead - see latestPerControl().
    const history = loadAssertions(arg(argv, 'assertions', 'fixtures/assertions'));
    const assertions = latestPerControl(history);
    const outDir = resolve(ROOT, arg(argv, 'out', 'out'));
    mkdirSync(outDir, { recursive: true });

    const written = [];
    const write = (name, doc) => {
      writeFileSync(join(outDir, name), serialize(doc));
      written.push(name);
    };

    write('oscal-catalog.json', catalog());
    for (const p of profiles()) write(`oscal-profile-${p.key}.json`, p.doc);
    write('oscal-component-definition.json', componentDefinition());
    write('oscal-assessment-plan.json', assessmentPlan());
    write('oscal-assessment-results.json', assessmentResults(assertions));

    const p = poam(assertions);
    for (const w of p.warnings) console.warn(`warn  ${w}`);
    write('oscal-poam.json', p.doc);

    write('oscal-ssp.json', ssp(assertions));

    console.log(`wrote ${written.length} artifact(s) to ${outDir}:`);
    for (const w of written) console.log(`  ${w}`);
    if (isFixtureSet(assertions)) {
      console.log(`\n${FIXTURE_STAMP}: generated from synthetic assertions. Not submittable.`);
    }
    return 0;
  }

  console.error(`unknown command: ${command}\n`);
  process.stdout.write(USAGE);
  return 1;
}

// The naive `file://${argv[1]}` comparison silently no-ops on Windows (three-slash URL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
