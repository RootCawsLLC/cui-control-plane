/**
 * Identifier constants. Committed, and never rotated — rotating either of these silently
 * reassigns every UUID and every prop in every artifact ever emitted.
 *
 * PROPS_NS is a URI we control, per control-architecture §6. It is an identifier, not a link;
 * it does not need to resolve. The house pattern is https://github.com/RootCawsLLC/<repo>/ns,
 * already used by ksi-harness, which is why Phase 0's "register the props namespace before any
 * OSCAL work starts" needed no new domain.
 *
 * UUID_NS is uuid5(NS_URL, PROPS_NS) — derived once so it is reproducible rather than random,
 * then frozen here as a literal so it cannot drift if the derivation changes.
 */
export const PROPS_NS = 'https://github.com/RootCawsLLC/cui-control-plane/ns';
export const FAIRCAM_NS = `${PROPS_NS}/faircam`;
export const UUID_NS = 'fe257ac3-9522-5d89-bdc1-242daee59e92';
export const OSCAL_VERSION = '1.1.3';
