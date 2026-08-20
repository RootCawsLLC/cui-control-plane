# ADR 0006 — Identifiers and our own reasoning; never framework text

**Status:** accepted · **Date:** 2026-08-19

## Context

A control repository that crosswalks to five regimes is under constant pressure to paste in the
source text — it makes the records read better and saves the reader a lookup. Three separate
reasons not to, of increasing force:

1. **Licensing.** AICPA and ISO material is copyright. The Secure Controls Framework is CC BY-ND,
   and its terms name **AI-generated derivative content specifically** as prohibited — which rules
   SCF out as a control spine for any tool that generates content, though SCF identifiers remain
   perfectly usable as crosswalk anchors.
2. **Staleness.** A hand-copied requirement is a statement that goes stale while continuing to read
   as current. Regimes in this space are actively moving: the §1260H list expanded in June 2026, and
   §866 harmonisation is still forthcoming.
3. **It is not ours.** The assertion text is the highest-value writing in the inventory precisely
   because it is ours — a testable claim over a defined population, which a query can prove. A
   paraphrase of somebody else's requirement is neither.

NIST SP 800-171 is a US Government work and therefore public domain, so reproducing *that* text
would be lawful. It is still excluded, on reasons 2 and 3.

## Decision

**This repository holds framework identifiers and our own reasoning. Nothing else.**

- `crosswalk[]` edges carry `framework`, `reference`, `confidence`, `basis`. `basis` is our stated
  reasoning so a reviewer can disagree with it; `confidence` is mandatory because an over-confident
  crosswalk an assessor relies on is worse than an absent one.
- `reference/nist-800-171r2.index.yaml` carries identifiers, family, and a null objective count.
  A test asserts each requirement entry has exactly those four keys, so the file cannot quietly
  grow a prose field.
- **SCF content is never vendored.** `scripts/import-scf.mjs` resolves crosswalk edges from a
  locally-obtained SCF release at run time, and `reference/scf/` is gitignored. Edges resolved that
  way are marked `inherited_via_scf: true` so inherited and hand-maintained mappings are never
  confused.
- The FATHOM5 community 800-171 OSCAL content is a **starting point to diff against**, not a
  dependency to vendor. It is community-sourced; check it against the official Rev 2 text before
  trusting it as a catalog layer.

## Consequences

- Reading a control record requires having the source open alongside it. That is the intended trade:
  the alternative is a repository that looks self-contained and is quietly wrong.
- Anything generated from this repository — SSP, POA&M, policy — contains our assertion text and
  framework identifiers, and can be published without a licensing review.
- Third-party attributions survive any scrub. Nothing in this repository currently carries one; if
  SCF or FATHOM5 content is ever consumed at run time, the attribution goes in the README and stays
  there.
