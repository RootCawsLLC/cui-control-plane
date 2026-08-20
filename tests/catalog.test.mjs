import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, loadControls, loadRequirementIndex } from '../src/lib/load.mjs';
import { validate, populationsAgree, extractDeclaredPopulation } from '../src/validate.mjs';
import { coverage } from '../src/coverage.mjs';
import {
  FAMILIES,
  EXPECTED_REQUIREMENTS,
  requirements,
} from '../scripts/gen-requirement-index.mjs';

test('the requirement index is 110 across 14 families', () => {
  const index = loadRequirementIndex();
  assert.equal(index.requirement_count, EXPECTED_REQUIREMENTS);
  assert.equal(index.requirements.length, EXPECTED_REQUIREMENTS);
  assert.equal(index.families.length, 14);
  assert.equal(
    FAMILIES.reduce((n, f) => n + f.last, 0),
    EXPECTED_REQUIREMENTS,
    'family counts must sum to 110 - if this fails, one family "last" value is wrong'
  );
});

test('the committed index matches what the generator produces', () => {
  // A hand edit to a generated file is how a wrong requirement identifier gets in and stays in.
  // Re-running the generator and diffing is cheaper than reviewing 110 lines.
  const before = readFileSync(join(ROOT, 'reference', 'nist-800-171r2.index.yaml'), 'utf8');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-requirement-index.mjs')], { cwd: ROOT });
  const after = readFileSync(join(ROOT, 'reference', 'nist-800-171r2.index.yaml'), 'utf8');
  assert.equal(before, after, 'reference/nist-800-171r2.index.yaml has been hand edited');
});

test('the index carries identifiers and no requirement text', () => {
  const raw = readFileSync(join(ROOT, 'reference', 'nist-800-171r2.index.yaml'), 'utf8');
  for (const r of requirements()) {
    assert.ok(raw.includes(`id: "${r.id}"`), `missing ${r.id}`);
  }
  // Every requirement entry has exactly four keys, none of which can hold prose.
  const index = loadRequirementIndex();
  for (const r of index.requirements) {
    assert.deepEqual(
      Object.keys(r).sort(),
      ['assessment_objectives', 'family', 'family_abbrev', 'id'],
      'a requirement entry grew a field - framework text must never land here'
    );
  }
});

test('the live inventory validates', () => {
  const { errors } = validate();
  assert.deepEqual(errors, []);
});

test('every control record carries a population, a query and an owner', () => {
  for (const c of loadControls()) {
    assert.ok(c.population_definition?.length > 20, `${c.control_id} population_definition`);
    assert.ok(c.query_ref?.startsWith('models/controls/'), `${c.control_id} query_ref`);
    assert.ok(c.owner?.length > 0, `${c.control_id} owner`);
    assert.equal(
      (c.faircam ?? []).filter((f) => f.primary).length,
      1,
      `${c.control_id} needs exactly one primary FAIR-CAM function`
    );
  }
});

test('layer-split siblings each state their rationale', () => {
  const mfa = loadControls().filter((c) => c.control_id.endsWith('.mfa'));
  assert.equal(mfa.length, 2, 'the enclave/corp-it MFA split is the worked example; keep both');
  for (const c of mfa) {
    assert.ok(c.split_rationale?.length > 40, `${c.control_id} needs a split_rationale`);
  }
});

test('the out-of-boundary MFA control does not claim an 800-171 requirement', () => {
  // Claiming it would inflate apparent coverage of the assessed scope with work no assessor looks
  // at, and would import corporate-IT failures into the SPRS derivation.
  const corp = loadControls().find((c) => c.control_id === 'ctl.iam.corp-it.mfa');
  const claims = (corp.crosswalk ?? []).filter((e) => e.framework === 'nist800171r2');
  assert.deepEqual(claims, []);
});

test('coverage does not count a low-confidence edge as covered', () => {
  const c = coverage();
  const weak = c.rows.find((r) => r.id === '3.11.1');
  assert.equal(weak.state, 'weak');
  assert.ok(c.operating + c.intended < c.requirement_count, 'coverage must not claim the full set');
  assert.equal(c.operating + c.intended + c.weak + c.uncovered, c.requirement_count);
});

test('population drift between record and model is detected', () => {
  assert.ok(populationsAgree('all human identities in the enclave identity provider, active only',
                             'All human identities in the enclave identity provider with status active'));
  assert.equal(
    populationsAgree('every supplier with an active contractual relationship',
                     'all managed endpoints enrolled in the enclave mobile device manager'),
    false
  );
});

test('a control model without a population header is refused', () => {
  assert.equal(extractDeclaredPopulation('select 1'), null);
});
