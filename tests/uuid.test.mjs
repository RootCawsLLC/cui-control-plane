import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuid5, NS_URL } from '../src/lib/uuid5.mjs';
import { UUID_NS, PROPS_NS } from '../src/lib/ns.mjs';

// The published RFC 4122 test vector. This is the whole reason to hand-roll v5 rather than reuse
// the sha256-into-v4-shape trick from ksi-harness: an assessor with any RFC 4122 library can
// recompute our identifiers and get the same answer. If this vector ever fails, every UUID in
// every emitted artifact is wrong in a way nothing else would catch.
test('uuid5 matches the RFC 4122 DNS/python.org vector', () => {
  const NS_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  assert.equal(uuid5(NS_DNS, 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
});

test('uuid5 sets version 5 and the RFC 4122 variant', () => {
  const u = uuid5(NS_URL, 'anything');
  assert.equal(u[14], '5', 'version nibble');
  assert.ok(['8', '9', 'a', 'b'].includes(u[19]), 'variant nibble');
});

test('the committed namespace is derived from the props namespace and has not drifted', () => {
  // Rotating either constant silently reassigns every UUID in every artifact ever emitted, so the
  // derivation is pinned here rather than trusted to a comment.
  assert.equal(uuid5(NS_URL, PROPS_NS), UUID_NS);
});

test('uuid5 is deterministic across calls', () => {
  assert.equal(uuid5(UUID_NS, 'ctl.iam.cui-enclave.mfa'), uuid5(UUID_NS, 'ctl.iam.cui-enclave.mfa'));
  assert.notEqual(uuid5(UUID_NS, 'ctl.iam.cui-enclave.mfa'), uuid5(UUID_NS, 'ctl.iam.corp-it.mfa'));
});
