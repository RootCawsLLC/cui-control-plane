#!/usr/bin/env node
// End-to-end walkthrough against the synthetic fixtures. Everything it prints is reproducible by
// running the commands it names.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../src/lib/load.mjs';

const cli = join(ROOT, 'src', 'cli.mjs');

const step = (title, args, { allowFailure = false } = {}) => {
  console.log(`\n${'='.repeat(78)}\n  ${title}\n  $ node src/cli.mjs ${args.join(' ')}\n${'='.repeat(78)}`);
  try {
    console.log(execFileSync(process.execPath, [cli, ...args], { cwd: ROOT, encoding: 'utf8' }));
  } catch (err) {
    if (!allowFailure) throw err;
    // The refusal path is part of the demo, not an accident in it. execFileSync already forwards
    // the child's stderr to ours, so re-printing err.stderr here would duplicate the message.
    console.log(err.stdout ?? '');
    console.log(`(exited ${err.status} - this refusal is the point of the step)`);
  }
};

step('1. Validate the inventory against schema and house rules', ['validate']);

step('2. Coverage of the 110 requirements - enumerated, never summarised', ['coverage']);

step(
  '3. SPRS against the REAL weights file, which ships unpopulated. The scorer refuses rather ' +
    'than returning a plausible number.',
  ['sprs', '--weights', 'reference/sprs-weights.yaml'],
  { allowFailure: true }
);

step(
  '4. SPRS against fixture weights. The arithmetic runs; the result is never called submittable.',
  ['sprs', '--weights', 'fixtures/sprs-weights.fixture.yaml']
);

step(
  '5. Variance Frequency and Variance Duration from the assertion history - the half that makes ' +
    'this a risk instrument rather than a compliance pipeline',
  ['variance']
);

step('6. Emit OSCAL O1-O5 from the fixture assertions', ['emit', 'all', '--out', 'out']);

console.log(
  '\nEverything in out/ is stamped NOT REAL EVIDENCE and re-exports byte-identically.\n' +
    'Verify that last claim yourself:\n\n' +
    '  cp -r out out.1 && node src/cli.mjs emit all && diff -r out.1 out && echo identical\n'
);
