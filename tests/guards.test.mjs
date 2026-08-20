import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import { loadControls } from '../src/lib/load.mjs';
import { validate } from '../src/validate.mjs';

/**
 * Proves the house rules are ARMED, not merely written down.
 *
 * Each case hands the validator a deliberately defective record and asserts it is refused.
 * Following the ksi-harness pattern: a guard nobody has watched fail is a guard nobody knows is
 * running.
 *
 * Records are injected rather than written into controls/ - node:test runs files in parallel
 * processes, so a test that mutates the inventory races every other test that reads it.
 */

const BASE = parse(`
control_id: ctl.iam.cui-enclave.mfa
title: Guard fixture
assertion: Every identity in the probe population has a factor enrolled.
layer: guard-fixture
owner: nobody
status: planned
faircam:
  - function: resistance
    primary: true
population_definition: >-
  All human identities in the CUI enclave identity provider with status active, excluding service
  principals and excluding break-glass accounts.
source_system: probe
query_ref: models/controls/ctl_iam_cui_enclave_mfa.sql
scenarios: [scn.probe.case]
`);

const probe = (overrides) => [{ ...BASE, ...overrides, _file: 'controls/probe.yaml' }];

test('the unmodified probe passes, so each case below isolates one defect', () => {
  const { errors } = validate({ controls: probe({}) });
  assert.deepEqual(errors, []);
});

test('an assertion that does not quantify over a population is refused', () => {
  const { errors } = validate({
    controls: probe({ assertion: 'Access is reviewed periodically by the security team.' }),
  });
  assert.ok(
    errors.some((e) => e.includes('does not quantify over a population')),
    errors.join('\n')
  );
});

test('a missing query_ref is refused - an unmeasurable control is not a control', () => {
  const { errors } = validate({
    controls: probe({ query_ref: 'models/controls/ctl_does_not_exist.sql' }),
  });
  assert.ok(errors.some((e) => e.includes('does not exist')), errors.join('\n'));
});

test('a population_definition that has drifted from its model is refused', () => {
  const { errors } = validate({
    controls: probe({
      population_definition:
        'Every supplier in the procurement vendor master with an active contractual relationship.',
    }),
  });
  assert.ok(errors.some((e) => e.includes('drifted apart')), errors.join('\n'));
});

test('a policy_ref on a control that is not operating is refused - policy last', () => {
  const { errors } = validate({
    controls: probe({ policy_ref: 'policies/access-control.md#probe' }),
  });
  assert.ok(
    errors.some((e) => e.includes('Never publish a policy for a control that is not operating')),
    errors.join('\n')
  );
});

test('two primary FAIR-CAM functions are refused', () => {
  const { errors } = validate({
    controls: probe({
      faircam: [
        { function: 'resistance', primary: true },
        { function: 'loss-reduction', primary: true },
      ],
    }),
  });
  assert.ok(errors.some((e) => e.includes('exactly one primary')), errors.join('\n'));
});

test('a crosswalk to a requirement outside the 110 is refused', () => {
  const { errors } = validate({
    controls: probe({
      crosswalk: [
        { framework: 'nist800171r2', reference: '3.5.99', confidence: 'high', basis: 'Invalid on purpose.' },
      ],
    }),
  });
  assert.ok(errors.some((e) => e.includes('3.5.99')), errors.join('\n'));
});

test('a control with no scenario warns that it is unpriced', () => {
  const { errors, warnings } = validate({ controls: probe({ scenarios: [] }) });
  assert.deepEqual(errors, [], 'an unpriced control is a warning, not a build failure');
  assert.ok(warnings.some((w) => w.includes('unpriced')), warnings.join('\n'));
});

test('a layer split with no rationale is refused', () => {
  // Two records sharing domain `iam` and leaf `mfa` owe a rationale each.
  const controls = [
    { ...BASE, control_id: 'ctl.iam.guard-a.mfa', _file: 'controls/a.yaml' },
    { ...BASE, control_id: 'ctl.iam.guard-b.mfa', _file: 'controls/b.yaml' },
  ];
  const { errors } = validate({ controls });
  assert.equal(errors.filter((e) => e.includes('split_rationale')).length, 2, errors.join('\n'));
});

test('a stated rationale satisfies the split guard', () => {
  const controls = [
    { ...BASE, control_id: 'ctl.iam.guard-a.mfa', split_rationale: 'Different owner and threat model.', _file: 'a' },
    { ...BASE, control_id: 'ctl.iam.guard-b.mfa', split_rationale: 'Different owner and threat model.', _file: 'b' },
  ];
  // Filtered rather than deep-equalled: these renamed ids are not the ones the borrowed query_ref
  // names, so the unrelated "never mentions" guard fires too. Asserting on the empty set here
  // would make this test about the wrong rule.
  assert.deepEqual(
    validate({ controls }).errors.filter((e) => e.includes('split_rationale')),
    []
  );
});

test('a duplicate control_id is refused - ids are stable and never reused', () => {
  const controls = [
    { ...BASE, split_rationale: 'x', _file: 'controls/a.yaml' },
    { ...BASE, split_rationale: 'x', _file: 'controls/b.yaml' },
  ];
  assert.ok(validate({ controls }).errors.some((e) => e.includes('duplicate control_id')));
});

test('a control model that never reaches the variance layer is refused', () => {
  const { errors } = validate({
    controls: probe({ query_ref: 'models/controls/ctl_iam_corp_it_mfa.sql' }),
  });
  // The model exists and is unioned, so the failure here is the mismatch check, not the union one.
  assert.ok(errors.some((e) => e.includes('never mentions')), errors.join('\n'));
});

test('the live inventory still validates after every guard case', () => {
  assert.deepEqual(validate().errors, []);
  assert.equal(loadControls().length, 6, 'a guard test must never add or remove a real control');
});
