import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT } from '../src/lib/load.mjs';

/**
 * The primary checkout is not a working tree, and the hook is what makes that true.
 *
 * On 2026-08-20 two sessions worked in one checkout of this repository. CLAUDE.md was rewritten
 * mid-edit under one of them, `.evidence/` was emptied between two commands, source files changed
 * under a read, and a `git add -A` swept the other session's unfinished Terraform into a staging
 * area it did not belong in. None of it was a conflict, so git had nothing to say.
 *
 * Written as a convention it would have been read only by whoever was already following it, which
 * is why it is a hook. And a hook nobody has watched refuse is a hook nobody knows is running -
 * so this drives real commits in a real repository with a real linked worktree, rather than
 * calling the script and trusting that git would have.
 */

const IDENT = ['-c', 'user.name=RootCawsLLC', '-c', 'user.email=317738477+RootCawsLLC@users.noreply.github.com'];

const git = (cwd, args, env = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' });

/** Returns the stderr of a commit that is expected to be refused. */
function commitExpectingRefusal(cwd, message, env = {}) {
  try {
    git(cwd, [...IDENT, 'commit', '-m', message], env);
    return null;
  } catch (e) {
    return String(e.stderr ?? '') + String(e.stdout ?? '');
  }
}

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-guard-'));
  const primary = join(dir, 'primary');
  mkdirSync(primary);
  git(primary, ['init', '--quiet', '--initial-branch=main']);

  // An initial commit, made before the hook is armed, so a worktree can be created from it.
  writeFileSync(join(primary, 'seed.txt'), 'seed\n');
  git(primary, ['add', 'seed.txt']);
  git(primary, [...IDENT, 'commit', '--quiet', '-m', 'seed']);

  // Arm the real hook, exactly as `npm run setup` does.
  //
  // The hooks directory is COMMITTED, not merely created. core.hooksPath is `.githooks`, a
  // relative path, and git resolves it against each working tree - so an untracked directory
  // exists only in the primary checkout and a linked worktree silently runs no hooks at all.
  // The first version of this scaffold made that mistake, and "a linked worktree commits
  // normally" passed because nothing was checking it.
  const hooks = join(primary, '.githooks');
  mkdirSync(hooks);
  const hook = join(hooks, 'pre-commit');
  copyFileSync(join(ROOT, '.githooks', 'pre-commit'), hook);
  chmodSync(hook, 0o755);
  git(primary, ['add', '.githooks/pre-commit']);
  git(primary, [...IDENT, 'commit', '--quiet', '-m', 'arm hooks']);

  git(primary, ['config', 'core.hooksPath', '.githooks']);

  return { dir, primary };
}

test('the primary checkout refuses a commit, and says where the work belongs', () => {
  const { dir, primary } = scaffold();
  try {
    writeFileSync(join(primary, 'work.txt'), 'session work\n');
    git(primary, ['add', 'work.txt']);

    const stderr = commitExpectingRefusal(primary, 'work in the shared tree');
    assert.ok(stderr, 'the commit was allowed in the primary checkout');
    assert.match(stderr, /refusing to commit in the primary checkout/);
    // A refusal that does not say what to do instead gets the hook deleted.
    assert.match(stderr, /worktree\.mjs add/);
    assert.match(stderr, /ALLOW_PRIMARY_COMMIT=1/);

    // Refusing must not cost the work. This is the difference between a guard and a hazard.
    assert.match(git(primary, ['diff', '--cached', '--name-only']), /work\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked worktree commits normally', () => {
  const { dir, primary } = scaffold();
  try {
    const wt = join(dir, 'wt');
    git(primary, ['worktree', 'add', '--quiet', wt, '-b', 'session-a']);

    writeFileSync(join(wt, 'work.txt'), 'session work\n');
    git(wt, ['add', 'work.txt']);
    git(wt, [...IDENT, 'commit', '--quiet', '-m', 'work in a worktree']);

    assert.match(git(wt, ['log', '-1', '--format=%s']), /work in a worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALLOW_PRIMARY_COMMIT is a deliberate exception, not a loophole left open', () => {
  const { dir, primary } = scaffold();
  try {
    writeFileSync(join(primary, 'urgent.txt'), 'deliberate\n');
    git(primary, ['add', 'urgent.txt']);
    git(primary, [...IDENT, 'commit', '--quiet', '-m', 'deliberate'], { ALLOW_PRIMARY_COMMIT: '1' });
    assert.match(git(primary, ['log', '-1', '--format=%s']), /deliberate/);

    // Only the exact value. A stray "0" or "false" must not read as permission.
    writeFileSync(join(primary, 'again.txt'), 'again\n');
    git(primary, ['add', 'again.txt']);
    for (const value of ['0', 'false', 'yes', '']) {
      const stderr = commitExpectingRefusal(primary, 'should be refused', { ALLOW_PRIMARY_COMMIT: value });
      assert.ok(stderr, `ALLOW_PRIMARY_COMMIT=${JSON.stringify(value)} was treated as permission`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the identity guard still runs, and runs first', () => {
  const { dir, primary } = scaffold();
  try {
    const wt = join(dir, 'wt');
    git(primary, ['worktree', 'add', '--quiet', wt, '-b', 'session-b']);
    writeFileSync(join(wt, 'work.txt'), 'x\n');
    git(wt, ['add', 'work.txt']);

    // In a worktree the primary check passes, so a wrong identity must still be caught: the two
    // guards are independent, and adding the second must not have shadowed the first.
    let stderr = null;
    try {
      git(wt, ['-c', 'user.name=Wrong', '-c', 'user.email=wrong@pm.me', 'commit', '-m', 'bad identity']);
    } catch (e) {
      stderr = String(e.stderr ?? '');
    }
    assert.ok(stderr, 'a wrong-identity commit was allowed in a worktree');
    assert.match(stderr, /wrong identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
