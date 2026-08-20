import { ids, metadata, sortKeys, ref, resource, crosswalkHref } from './common.mjs';
import { loadControls, loadRequirementIndex } from '../lib/load.mjs';

/**
 * O2 - Catalog and Profile.
 *
 * We author our own catalog because there is no alternative: CMMC is legally pinned to 800-171
 * Rev 2, and usnistgov/oscal-content ships an OSCAL catalog for Rev 3 only. NIST publishes OSCAL
 * for the revision that does not legally apply.
 *
 * WHAT IS IN THE CATALOG: our controls, with our assertion text.
 * WHAT IS NOT: NIST requirement text. The 110 identifiers appear as crosswalk links and as
 * profile import selections - never with their prose. See ADR 0006.
 *
 * The PROFILE is the piece that is usually skipped and is the reason a Statement of Applicability
 * is defensible or is not. It records why each control is in or out. An SoA is supposed to prove
 * exactly that and normally cannot.
 */

export function catalog() {
  const controls = loadControls();

  return {
    catalog: sortKeys({
      uuid: ids.document('catalog'),
      metadata: metadata({ title: 'CUI control plane - house control catalog' }),
      groups: groupsByDomain(controls),
    }),
  };
}

function groupsByDomain(controls) {
  const byDomain = new Map();
  for (const c of controls) {
    const domain = c.control_id.split('.')[1];
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), c]);
  }
  return [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, group]) => ({
      id: `grp-${domain}`,
      title: domain,
      controls: group.map((c) => ({
        id: c.control_id,
        title: c.title,
        props: [
          { name: 'label', value: c.control_id },
          { name: 'status', value: c.status },
          { name: 'layer', value: c.layer },
          { name: 'owner', value: c.owner },
        ],
        parts: [
          // The assertion is the statement. It is ours, it quantifies over a population, and it is
          // the thing a query proves - which is why it is the catalog statement rather than a
          // paraphrase of somebody else's requirement.
          { id: `${c.control_id}_smt`, name: 'statement', prose: c.assertion },
          { id: `${c.control_id}_pop`, name: 'item', title: 'Population', prose: c.population_definition },
          ...(c.split_rationale
            ? [{ id: `${c.control_id}_split`, name: 'item', title: 'Layer split rationale', prose: c.split_rationale }]
            : []),
        ],
        links: (c.crosswalk ?? []).map((edge) => ({
          href: crosswalkHref(edge.framework, edge.reference),
          rel: 'related',
          text: `${edge.framework} ${edge.reference} (confidence: ${edge.confidence}) - ${edge.basis}`,
        })),
      })),
    }));
}

/**
 * A Profile per regime. `include-controls` selects what is in scope; `remarks` on each profile
 * carries the tailoring statement - the part that makes exclusion a recorded decision rather than
 * an absence somebody has to notice.
 */
export function profiles() {
  const controls = loadControls();
  const index = loadRequirementIndex();

  const inBoundary = controls.filter((c) => c.layer !== 'corp-it');
  const scrm = controls.filter((c) => c.control_id.startsWith('ctl.scrm.'));

  return [
    profile({
      key: 'cmmc-l2',
      title: 'CMMC Level 2 - CUI boundary',
      controls: inBoundary,
      remarks:
        `Selects the controls inside the CUI boundary. ${index.requirement_count} NIST SP 800-171 ` +
        'Rev 2 requirements are the assessment target; this profile selects OUR controls that ' +
        'claim them, and coverage of the requirement set is reported separately by `ccp coverage` ' +
        'rather than implied by this selection.\n\n' +
        'EXCLUDED AND WHY: ctl.iam.corp-it.mfa and any other corp-it layer control are outside the ' +
        'assessed boundary. They are excluded deliberately, not omitted - importing them would put ' +
        'corporate-IT failures into an SPRS score they have no business affecting.',
    }),
    profile({
      key: 'scrm',
      title: 'Supply chain screening - 1260H, Section 889, FASC',
      controls: scrm,
      remarks:
        'Three distinct authorities over one supplier population: the FY2021 NDAA Section 1260H ' +
        'contracting prohibition, the FY2019 NDAA Section 889 covered-telecommunications ' +
        'prohibition, and FASC exclusion and removal orders under a separate statute entirely. ' +
        'They are one profile because they ask the same population question, and they are named ' +
        'separately here because conflating the authorities in prose would be an error.',
    }),
  ];
}

function profile({ key, title, controls, remarks }) {
  return {
    key,
    doc: {
      profile: sortKeys({
        uuid: ids.document(`profile|${key}`),
        metadata: metadata({ title }),
        imports: [
          {
            href: ref('catalog'),
            'include-controls': [{ 'with-ids': controls.map((c) => c.control_id).sort() }],
          },
        ],
        merge: { 'as-is': true },
        'back-matter': {
          resources: [
            // The import href above is a UUID fragment, so it needs something in back-matter to
            // land on. Without this the profile references a catalog the validator cannot resolve.
            resource('catalog', 'House control catalog', 'oscal-catalog.json'),
            {
              uuid: ids.document(`profile-tailoring|${key}`),
              title: 'Tailoring statement',
              description: remarks,
            },
          ],
        },
      }),
    },
  };
}
