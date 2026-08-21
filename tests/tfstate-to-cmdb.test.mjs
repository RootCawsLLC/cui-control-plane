import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractAssets, toCsv, suspectSecrets } from '../scripts/tfstate-to-cmdb.mjs';

// A state carrying exactly the things that must NOT reach the CSV: a database password, an access
// key, a private key, and a data source describing infrastructure Terraform does not manage.
const STATE = {
  resources: [
    {
      mode: 'managed',
      type: 'aws_db_instance',
      name: 'primary',
      module: 'module.data',
      instances: [
        {
          attributes: {
            id: 'db-enclave-01',
            arn: 'arn:aws:rds:us-east-1:1:db:db-enclave-01',
            password: 'hunter2-the-actual-password',
            master_user_secret: [{ secret_arn: 'arn:aws:secretsmanager:...' }],
            endpoint: 'db-enclave-01.abc.us-east-1.rds.amazonaws.com',
          },
        },
      ],
    },
    {
      mode: 'managed',
      type: 'aws_iam_access_key',
      name: 'ci',
      instances: [
        {
          attributes: {
            id: 'AKIAIOSFODNN7EXAMPLE',
            secret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
            ses_smtp_password_v4: 'BFOOBARBAZQUUXCORGEGRAULTGARPLYWALDO',
          },
        },
      ],
    },
    {
      // Read, not managed. Claiming it would assert ownership of somebody else's infrastructure.
      mode: 'data',
      type: 'aws_vpc',
      name: 'shared',
      instances: [{ attributes: { id: 'vpc-shared-999', arn: 'arn:aws:ec2:::vpc/vpc-shared-999' } }],
    },
    {
      // Not an AWS resource at all.
      mode: 'managed',
      type: 'random_password',
      name: 'seed',
      instances: [{ attributes: { id: 'none', result: 'correct-horse-battery-staple' } }],
    },
    {
      mode: 'managed',
      type: 'aws_s3_bucket',
      name: 'evidence',
      instances: [{ attributes: { id: 'enclave-evidence', arn: 'arn:aws:s3:::enclave-evidence' } }],
    },
  ],
};

const rows = extractAssets(STATE);
const csv = toCsv(rows);

test('only identity fields survive - no attribute values at all', () => {
  for (const forbidden of [
    'hunter2-the-actual-password',
    'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    'BFOOBARBAZQUUXCORGEGRAULTGARPLYWALDO',
    'correct-horse-battery-staple',
    'rds.amazonaws.com',
    'secretsmanager',
  ]) {
    assert.ok(!csv.includes(forbidden), `${forbidden} leaked into the CSV`);
  }
});

test('data sources are excluded - reading is not managing', () => {
  assert.ok(!rows.some((r) => r.asset_id === 'vpc-shared-999'));
});

test('non-AWS resources are excluded', () => {
  assert.ok(!rows.some((r) => r.asset_type === 'random_password'));
});

test('managed AWS resources are kept, keyed by id', () => {
  const ids = rows.map((r) => r.asset_id);
  assert.ok(ids.includes('db-enclave-01'));
  assert.ok(ids.includes('enclave-evidence'));
  assert.ok(ids.includes('AKIAIOSFODNN7EXAMPLE'), 'the key id is an identifier, unlike its secret');
});

test('classification is blank, never invented', () => {
  // State says what exists, not how it is classified. Filling this in would manufacture a
  // classification nobody assigned and the control would pass on it.
  for (const r of rows) assert.equal(r.classification, '');
});

test('owner comes from the module, so a finding routes somewhere', () => {
  assert.equal(rows.find((r) => r.asset_id === 'db-enclave-01').owner, 'data');
});

test('the secret heuristic catches an opaque token in an identifier field', () => {
  const planted = [
    { asset_id: 'x', asset_type: 'aws_s3_bucket', owner: 'o', classification: '', in_cui_boundary: 'true' },
    {
      asset_id: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYwJalrXUtnFEMI',
      asset_type: 'aws_iam_access_key',
      owner: 'o',
      classification: '',
      in_cui_boundary: 'true',
    },
  ];
  assert.equal(suspectSecrets(planted).length, 1);
  // Real identifiers contain separators and must not trip it.
  assert.equal(suspectSecrets(rows).length, 0, JSON.stringify(suspectSecrets(rows)));
});

test('csv quoting survives a comma in a value', () => {
  const out = toCsv([
    { asset_id: 'a,b', asset_type: 't', owner: 'o', classification: '', in_cui_boundary: 'true' },
  ]);
  assert.match(out, /"a,b"/);
});
