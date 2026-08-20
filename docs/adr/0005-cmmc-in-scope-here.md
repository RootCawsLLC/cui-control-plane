# ADR 0005 — CMMC is in scope here, and why that does not contradict ksi-harness

**Status:** accepted · **Date:** 2026-08-19

## Context

`RootCawsLLC/ksi-harness` ADR 0004 says, plainly:

> CMMC is explicitly out of scope here. Spending engineering effort on it now is a bad trade, and
> saying that is a position rather than an omission.

Its reasoning was sound for that repository: `ksi-harness` targets FedRAMP 20x, CMMC would have
required authoring an 800-171 Rev 2 catalog from scratch because NIST publishes OSCAL only for
Rev 3, and CMMC Phase 2 designation was suspended on 13 July 2026 with a Reform Task Force report
due around mid-September 2026.

This repository does the opposite. Two in-house repositories silently disagreeing about whether
CMMC is worth building is worse than either position, so the disagreement is written down.

## Decision

CMMC Level 2 is in scope **here**, and out of scope **there**. Both remain correct because the
scoping question is different in each.

- **`ksi-harness` collects evidence against FedRAMP 20x indicators** and crosswalks transitively
  through 800-53 Rev 5. CMMC does not sit on that pivot: it is keyed to 800-171 Rev 2, which has no
  official OSCAL catalog and is not reachable from the FedRAMP ruleset. Adding it there would have
  meant a second collection programme inside a repository whose entire architecture is "one
  collection, many frameworks."
- **This repository starts from a CUI boundary**, where 800-171 Rev 2 *is* the requirements body and
  the catalog has to be authored regardless. The cost `ksi-harness` refused to pay is the entry
  price here, and it is paid once.

## What the suspension does and does not change

The Phase 2 suspension changes **which assessment path** applies, not whether the obligation exists:

- The safeguarding and incident-reporting obligations under DFARS 252.204-7012 are standing and
  live. They do not depend on CMMC phasing at all.
- §889 annual representation and the §1260H contracting prohibition are standing and live, and
  neither is a CMMC requirement.
- A Level 2 **self**-assessment still needs a defensible SSP, a real SPRS score, and a POA&M. The
  suspension removes the C3PAO path for now; it does not remove the assessment.

So the architecture is built for either path and the C3PAO route is not front-run. Where the plan
assumed a third-party assessment, treat that as the eventual state rather than the current one —
see `docs/watch-items.md`, which tracks it as a dated item to re-check rather than as settled fact.

## Consequences

- The one technical fact `ksi-harness` established — that CMMC-relevant OSCAL work means authoring
  your own Rev 2 catalog — is inherited here as a requirement rather than rediscovered. See
  ADR 0002.
- If the Reform Task Force output materially changes the assessment mechanics, the affected surface
  is the SPRS derivation and the profile tailoring statements. The control inventory and the
  evidence pipeline are unaffected, which is the point of ADR 0001.
- `ksi-harness` ADR 0004 should not be edited to match. It was right when written, for the
  repository it was written in; this ADR is the pointer that stops the two reading as an
  unresolved contradiction.
