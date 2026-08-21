#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, loadAssertions, latestPerControl, isFixtureSet, FIXTURE_STAMP } from './lib/load.mjs';
import { validate } from './validate.mjs';
import { coverage, formatCoverage } from './coverage.mjs';
import { score, formatScore, UnverifiedWeights } from './sprs.mjs';
import { variance, formatVariance } from './variance.mjs';
import { policy, formatPolicy } from './policy.mjs';
import { representation889, formatRepresentation } from './representation.mjs';
import { loadConfig, ConfigError, CONFIG_FILE } from './config.mjs';
import { init } from './init.mjs';
import { doctor, formatDoctor, writeTemplates } from './doctor.mjs';
import { runPipeline, formatPipeline } from './pipeline.mjs';
import { serialize } from './oscal/common.mjs';
import { catalog, profiles } from './oscal/catalog.mjs';
import { componentDefinition } from './oscal/component-definition.mjs';
import { assessmentResults } from './oscal/assessment-results.mjs';
import { poam } from './oscal/poam.mjs';
import { ssp } from './oscal/ssp.mjs';
import { assessmentPlan } from './oscal/assessment-plan.mjs';

const USAGE = `ccp - CUI control plane

  ccp init                        interview -> ccp.config.yaml (start here)
  ccp doctor                      what is configured, what is missing, what will run
  ccp pipeline  [--fixture]       collect -> load -> build -> assert, writing .evidence/
                [--require-real]  refuse to write synthetic evidence (use for scheduled runs)

  ccp validate                    schema + house rules over controls/ and models/
  ccp coverage                    which of the 110 requirements have a control
  ccp sprs      [--assertions D] [--weights F]   derive the SPRS score
  ccp variance  [--assertions D]                 VF/VD per control, from assertion history
  ccp policy    [--assertions D] [--out D]       generate policy from OPERATING controls only
  ccp representation 889 [--assertions D] [--out D]   regenerate the Section 889 representation
  ccp emit all  [--assertions D] [--out D]       OSCAL O1-O5

House rules enforced by validate: assertions quantify over a population; query_ref exists and
matches its record; a layer split states its rationale; policy_ref requires an operating control;
every control model reaches the variance layer.
`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

async function main(argv) {
  const [command, sub] = argv;

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'init') {
    return init({ force: argv.includes('--force') });
  }

  if (command === 'doctor') {
    if (argv.includes('--templates')) {
      const written = writeTemplates();
      console.log('Wrote header-only CSV templates:');
      for (const w of written) console.log('  ' + w);
      console.log('');
      console.log('Fill in the ones you can, rename to match ccp.config.yaml, then re-run the pipeline.');
      return 0;
    }
    const report = doctor();
    console.log(formatDoctor(report));
    return report.blocking > 0 ? 1 : 0;
  }

  if (command === 'pipeline') {
    const config = loadConfig();
    if (config._usingExample) {
      console.log('Using the bundled example config - no ccp.config.yaml yet.');
      console.log('Run `npm run init` to make it yours. Nothing below touches a real system.');
      console.log('');
    }
    const fixture = argv.includes('--fixture') || config._usingExample;

    // A scheduled, unattended run must never contribute synthetic snapshots to a real evidence
    // history. This is not hypothetical: ccp.config.yaml is gitignored - correctly, it describes one
    // organisation and belongs in that organisation's repository - so a CI checkout has no config,
    // falls back to the bundled example, and collects fixtures. The job goes green, the numbers look
    // plausible, and fixture data enters the audit trail that Variance Duration is computed from.
    if (argv.includes('--require-real') && fixture) {
      console.error('refusing to run: --require-real was given but this run would use FIXTURE data.');
      console.error('');
      console.error(config._usingExample
        ? `  cause: no ${CONFIG_FILE} was found, so the bundled example config was used.`
        : '  cause: --fixture was passed explicitly.');
      console.error('');
      console.error('  A scheduled run must collect from real systems or collect nothing. Supply the');
      console.error('  organisation config before collecting - see docs/SETUP.md.');
      return 2;
    }
    console.log(fixture ? 'Collecting (FIXTURE MODE - no real system is contacted):' : 'Collecting:');
    const result = await runPipeline({ config, fixture });
    console.log('');
    console.log(formatPipeline(result));
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

  if (command === 'policy') {
    const assertions = loadAssertions(arg(argv, 'assertions', 'fixtures/assertions'));
    const result = policy({ assertions });
    if (result.documents.length > 0) {
      const outDir = resolve(ROOT, arg(argv, 'out', 'out/policy'));
      mkdirSync(outDir, { recursive: true });
      for (const d of result.documents) writeFileSync(join(outDir, d.filename), d.body);
    }
    console.log(formatPolicy(result));
    return 0;
  }

  if (command === 'representation') {
    if (sub !== '889') {
      console.error('only `ccp representation 889` is supported today.');
      return 1;
    }
    const assertions = loadAssertions(arg(argv, 'assertions', 'fixtures/assertions'));
    const r = representation889({ assertions });
    if (r.body) {
      const outDir = resolve(ROOT, arg(argv, 'out', 'out'));
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'representation-889.md'), r.body);
    }
    console.log(formatRepresentation(r));
    // A blocked representation is not a crash, but it must not read as success to a CI step.
    return r.state === 'affirmative' ? 0 : 3;
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
    // VF/VD come from the full history even though the package itself is point-in-time - that is
    // the whole purpose of the props extension: the OSCAL package carries the risk layer.
    const measured = variance(history).rows;

    write('oscal-component-definition.json', componentDefinition({ measured }));
    write('oscal-assessment-plan.json', assessmentPlan());
    write('oscal-assessment-results.json', assessmentResults(assertions, { measured }));

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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      // A config problem is a setup mistake, not a crash. Print the guidance and nothing else -
      // a stack trace here teaches the analyst that the tool is broken rather than unconfigured.
      if (err instanceof ConfigError) {
        console.error(err.message);
        process.exit(1);
      }
      console.error(err.stack ?? err.message);
      process.exit(1);
    }
  );
}

export { main };
