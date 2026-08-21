import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconciliationErrors } from '../src/validate.mjs';
import { TABLES } from '../src/collectors/tables.mjs';

/**
 * Proves the `reconciles_with` rule is ARMED, not merely written down.
 *
 * Every way of getting this declaration wrong makes the overlap check quietly not apply rather
 * than fail: a typo names no table, an asymmetric pair is examined from one side only, a missing
 * subject_key skips the comparison, and a subject_key outside `required` lets a source load with
 * no such column - two empty identifier sets, overlap of zero over zero, silence.
 *
 * Silence is indistinguishable from "these sources agree". That reading is what let a control
 * report 81 unmanaged assets against two inputs that were not about each other.
 *
 * Registries are injected rather than edited into tables.mjs: node:test runs files in parallel
 * processes, so mutating the real registry would race every other test that reads it.
 */

/** A minimal, correct reconciling pair. Each case below breaks exactly one thing in it. */
const pair = (overrides = {}) => ({
  src_left: {
    role: 'population',
    controls: ['ctl.cui.boundary.asset-inventory'],
    subject_key: 'asset_id',
    reconciles_with: ['src_right'],
    required: ['asset_id'],
    columns: ['asset_id', 'owner'],
    ...(overrides.left ?? {}),
  },
  src_right: {
    role: 'population',
    controls: ['ctl.cui.boundary.asset-inventory'],
    subject_key: 'resource_id',
    reconciles_with: ['src_left'],
    required: ['resource_id'],
    columns: ['resource_id', 'owner_tag'],
    ...(overrides.right ?? {}),
  },
  ...(overrides.extra ?? {}),
});

const only = (errors, re) => errors.filter((e) => re.test(e));

test('the correct pair passes, so the cases below fail for their own reason', () => {
  assert.deepEqual(reconciliationErrors(pair()), []);
});

test('a typo naming no table is refused - it would disable the check silently', () => {
  const errors = reconciliationErrors(pair({ left: { reconciles_with: ['src_rihgt'] } }));
  assert.ok(only(errors, /not a table/).length > 0, JSON.stringify(errors));
});

test('an asymmetric declaration is refused', () => {
  const errors = reconciliationErrors(pair({ right: { reconciles_with: [] } }));
  assert.ok(only(errors, /does not name it back/).length > 0, JSON.stringify(errors));
});

test('a table reconciling with itself is refused', () => {
  const errors = reconciliationErrors(pair({ left: { reconciles_with: ['src_left'] } }));
  assert.ok(only(errors, /names itself/).length > 0, JSON.stringify(errors));
});

test('reconciling against a reference list is refused', () => {
  // A published list is something a control joins against. Overlap with one proves nothing about
  // the population - the same conflation that made the 889 control assert 0 of 0 passing.
  const errors = reconciliationErrors(pair({ right: { role: 'reference' } }));
  assert.ok(only(errors, /reference table/).length > 0, JSON.stringify(errors));
});

test('a missing subject_key is refused - there would be no column to compare', () => {
  const errors = reconciliationErrors(pair({ right: { subject_key: undefined } }));
  assert.ok(only(errors, /declares no subject_key/).length > 0, JSON.stringify(errors));
});

test('a subject_key outside required is refused - the silent-agreement case', () => {
  // This is the subtle one. The column is real, so nothing looks wrong; but a CSV without it
  // still loads, both identifier sets come out empty, and zero-over-zero reads as agreement.
  const errors = reconciliationErrors(pair({ left: { required: [] } }));
  assert.ok(only(errors, /not in required/).length > 0, JSON.stringify(errors));
});

test('a subject_key that is not a column of its own table is refused', () => {
  const errors = reconciliationErrors(pair({ left: { subject_key: 'nonesuch', required: ['nonesuch'] } }));
  assert.ok(only(errors, /not one of the table's columns/).length > 0, JSON.stringify(errors));
});

test('a pair serving no control in common is refused', () => {
  const errors = reconciliationErrors(pair({ right: { controls: ['ctl.iam.corp-it.mfa'] } }));
  assert.ok(only(errors, /no control in common/).length > 0, JSON.stringify(errors));
});

test('a population table that reconciles with nothing is fine', () => {
  // src_mdm_devices_snapshot is exactly this: laptops share nothing with cloud resources, and an
  // endpoint absent from the CMDB is a real finding rather than a source error.
  const errors = reconciliationErrors({
    src_alone: {
      role: 'population',
      controls: ['ctl.cui.boundary.asset-inventory'],
      subject_key: 'device_id',
      required: ['device_id'],
      columns: ['device_id'],
    },
  });
  assert.deepEqual(errors, []);
});

test('the real registry satisfies the rule', () => {
  // Armed, and not merely refusing everything.
  assert.deepEqual(reconciliationErrors(TABLES), []);
});

test('the real registry actually declares a pair for the rule to check', () => {
  const declaring = Object.entries(TABLES).filter(([, d]) => (d.reconciles_with ?? []).length > 0);
  assert.ok(declaring.length >= 2, 'no reconciling pair is declared, so the rule guards nothing');
});
