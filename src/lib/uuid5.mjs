import { createHash } from 'node:crypto';

/**
 * RFC 4122 v5 (SHA-1, name-based) UUIDs.
 *
 * Node ships `crypto.randomUUID` (v4) and nothing else, so this is hand-rolled. It is worth
 * the twenty lines: v5 over a fixed namespace is what makes an unchanged control inventory
 * re-export byte-identically, which is what makes an OSCAL package reviewable as a Git diff
 * instead of a blob that changes every run. See docs/adr/0003-deterministic-uuids.md.
 *
 * Deliberately NOT the sha256-truncated-into-v4-shape trick used in ksi-harness. That produces
 * stable identifiers but they are not v5, so no other implementation given the same namespace
 * and name reproduces them. Here an assessor can recompute our UUIDs with any RFC 4122 library
 * and get the same answer, which is the property that actually matters to a third party.
 */

/** RFC 4122 Appendix C, the URL namespace. */
export const NS_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const hexToBytes = (uuid) => Buffer.from(uuid.replace(/-/g, ''), 'hex');

const bytesToUuid = (b) =>
  [
    b.subarray(0, 4).toString('hex'),
    b.subarray(4, 6).toString('hex'),
    b.subarray(6, 8).toString('hex'),
    b.subarray(8, 10).toString('hex'),
    b.subarray(10, 16).toString('hex'),
  ].join('-');

/** uuid5(namespace, name) — namespace is a UUID string, name is any string. */
export function uuid5(namespace, name) {
  const hash = createHash('sha1')
    .update(hexToBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}
