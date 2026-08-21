#!/usr/bin/env node
// Arms the commit-identity guard for this clone.
//
// Runs from `npm run setup` and, more importantly, automatically from npm's `prepare` hook
// on `npm install`. That automation is the point: neither git hooks nor local git config
// survive a clone, so a fresh checkout otherwise has no identity configured and no guard,
// and the first commit is authored wrongly — which the RootCawsLLC account rejects on push
// and which can only be fixed by rewriting history. `npm install` is the one command nobody
// skips, so it is the right place to close that window.
//
// This never fails an install. Not being a git checkout is a normal state (an extracted
// tarball, a vendored copy), not an error worth breaking `npm install` over.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHOR_NAME = 'RootCawsLLC';
const AUTHOR_EMAIL = '317738477+RootCawsLLC@users.noreply.github.com';
const HOOKS_PATH = '.githooks';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A missing git binary reports status null rather than a non-zero exit, so test for 0.
const git = (...args) => spawnSync('git', args, { cwd: packageRoot, encoding: 'utf8' });
const gitValue = (...args) => {
  const result = git(...args);
  return result.status === 0 ? result.stdout.trim() : null;
};

const topLevel = gitValue('rev-parse', '--show-toplevel');
if (topLevel === null) process.exit(0);

// Only arm the repo we are actually the root of. If grc-wizard has been vendored into some
// larger checkout, the enclosing repo has its own identity rules and none of this applies.
if (resolve(topLevel) !== packageRoot) process.exit(0);
if (!existsSync(join(packageRoot, HOOKS_PATH, 'pre-commit'))) process.exit(0);

const settings = [
  ['core.hooksPath', HOOKS_PATH],
  ['user.name', AUTHOR_NAME],
  ['user.email', AUTHOR_EMAIL],
];

const changed = [];
for (const [key, value] of settings) {
  if (gitValue('config', '--local', '--get', key) === value) continue;
  if (git('config', '--local', key, value).status === 0) changed.push(key);
}

// Report only when something moved: a silent no-op on every `npm install` is noise, but a
// silent *change* to how commits are authored is worse.
if (changed.length > 0) {
  console.log(`cui-control-plane: armed the commit-identity guard (${changed.join(', ')}).`);
  console.log(`  commits are now authored ${AUTHOR_NAME} <${AUTHOR_EMAIL}>, enforced by ${HOOKS_PATH}/pre-commit`);
  console.log('  that hook also refuses commits in the primary checkout - work belongs in a worktree:');
  console.log('    node ~/.claude/scripts/worktree.mjs add cui-control-plane <branch>');
}
