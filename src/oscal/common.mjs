import { uuid5 } from '../lib/uuid5.mjs';
import { UUID_NS, PROPS_NS, FAIRCAM_NS, OSCAL_VERSION } from '../lib/ns.mjs';
import { FIXTURE_STAMP } from '../lib/load.mjs';

export { UUID_NS, PROPS_NS, FAIRCAM_NS, OSCAL_VERSION };

/**
 * Every UUID in every emitted artifact comes through one of these. The natural keys are the
 * stable ones - control_id, and control_id plus as_of - never a filename, never a position in an
 * array, and never the clock.
 */
export const ids = {
  document: (kind) => uuid5(UUID_NS, `document|${kind}`),
  component: (controlId) => uuid5(UUID_NS, controlId),
  implementedRequirement: (controlId, framework, item) =>
    uuid5(UUID_NS, `${controlId}|${framework}|${item}`),
  result: (controlId, asOf) => uuid5(UUID_NS, `${controlId}|${asOf}`),
  observation: (controlId, asOf) => uuid5(UUID_NS, `observation|${controlId}|${asOf}`),
  finding: (controlId, asOf) => uuid5(UUID_NS, `finding|${controlId}|${asOf}`),
  poamItem: (controlId, subjectId) => uuid5(UUID_NS, `poam|${controlId}|${subjectId}`),
  party: (name) => uuid5(UUID_NS, `party|${name}`),
};

/**
 * Cross-document references.
 *
 * OSCAL resolves `#…` fragments as UUIDs and will try to follow them. A readable fragment like
 * `#catalog` is not a schema error you can see by eye - it fails deep inside the validator with
 * "Invalid UUID string: catalog", which is how it was found here. Always reference a document by
 * its deterministic UUID, and give the reference something to land on in back-matter.
 */
export const ref = (kind) => `#${ids.document(kind)}`;

/** A back-matter resource so a `ref()` fragment resolves to the emitted file rather than dangling. */
export const resource = (kind, title, filename) => ({
  uuid: ids.document(kind),
  title,
  rlinks: [{ href: `./${filename}` }],
});

/**
 * Crosswalk links use a URN rather than a fragment, for the same reason. A crosswalk target is an
 * external identifier, not a document this package contains - modelling it as `#framework:item`
 * invites the validator to resolve a fragment that was never going to exist.
 */
export const crosswalkHref = (framework, reference) =>
  `urn:rootcaws:cui-control-plane:${framework}:${encodeURIComponent(reference)}`;

/**
 * `last-modified` is a real problem for byte-stability: OSCAL requires it, and setting it to the
 * clock means every export differs from the last even when nothing changed, which destroys the
 * property the deterministic UUIDs exist to create.
 *
 * So it is derived from the CONTENT instead - the newest as_of in the evidence, or a fixed epoch
 * when there is none. An unchanged inventory with unchanged evidence re-exports byte-identically;
 * a real change moves the timestamp because a real change moves the evidence.
 */
export const EPOCH = '1970-01-01T00:00:00.000Z';

export function lastModified(assertions = []) {
  if (assertions.length === 0) return EPOCH;
  return assertions.map((a) => a.as_of).sort().at(-1);
}

export function metadata({ title, assertions = [], isFixture = false }) {
  return sortKeys({
    title: isFixture ? `${title} [${FIXTURE_STAMP}]` : title,
    'last-modified': lastModified(assertions),
    version: '0.1.0',
    'oscal-version': OSCAL_VERSION,
    ...(isFixture
      ? {
          remarks:
            `${FIXTURE_STAMP}. This package was generated from synthetic assertion records and ` +
            'must not be submitted, shared as assurance, or cited as the state of any real system.',
        }
      : {}),
  });
}

/** FAIR-CAM measurement carried on OSCAL props. Spec-legal, and ignorable by tools that do not know the namespace. */
export function faircamProps(control, asOf) {
  const props = [];
  for (const f of control.faircam ?? []) {
    props.push({ ns: FAIRCAM_NS, name: 'function', value: f.function, class: f.primary ? 'primary' : 'secondary' });
  }
  const m = control.measurement ?? {};
  const numeric = [
    ['intended-efficacy', m.intended_efficacy],
    ['variant-efficacy', m.variant_efficacy],
    ['coverage', m.coverage],
    ['confidence-tier', m.confidence_tier],
  ];
  for (const [name, value] of numeric) {
    // An unmeasured parameter is omitted, not defaulted. A zero here would read as "measured and
    // found to be nothing", which is a different and much worse claim than "not yet measured".
    if (value === null || value === undefined) continue;
    props.push({ ns: FAIRCAM_NS, name, value: String(value) });
  }
  if (asOf) props.push({ ns: FAIRCAM_NS, name: 'as-of', value: asOf });
  return props;
}

/** Recursively sorts object keys so serialization is stable regardless of construction order. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])])
  );
}

/** One serializer for every artifact: sorted keys, two-space indent, trailing newline. */
export const serialize = (doc) => `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
