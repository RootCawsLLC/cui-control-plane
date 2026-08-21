# Watch items

Things this repository deliberately does **not** assert, each with what would settle it. The point
of the list is that "we checked and it is empty" and "nobody checked" must never look the same from
the outside.

Anything here that is machine-checkable is wired to a refusal or a warning in code, named in the
last column.

| # | Item | Status | Settled by | Enforced where |
|---|---|---|---|---|
| 1 | **SPRS per-requirement weights** | unverified, all null | The current NIST SP 800-171 DoD Assessment Methodology. Set `weight` and `verified: true` in `reference/sprs-weights.yaml`. | `src/sprs.mjs` throws `UnverifiedWeights` and names every offender |
| 2 | **Non-POA&M-able requirement subset** | unverified, empty | The live 32 CFR Part 170 text — read it, not a secondary source. Several requirements cannot be carried on a POA&M regardless of score. | `src/oscal/poam.mjs` warns on every run while `verified: false` |
| 3 | **Assessment objective counts** | null per requirement | NIST SP 800-171A. 320 across the 110 is the published total and is recorded as a checkable expectation, not distributed as a guess. | `reference/nist-800-171r2.index.yaml` |
| 4 | **§1260H implementing clause designation** | authority cited, clause not | The FAR/DFARS clause designation is still settling. The statutory authority is cited instead. | crosswalk `basis` on `ctl.scrm.procurement.entity-list-screening` |
| 5 | **CMMC assessment path** | self-assessment assumed | Phase 2 designation was suspended 13 Jul 2026 (Level 1/2 Self only, no waivers), with a Reform Task Force report expected around mid-Sep 2026. The C3PAO path is not front-run. | [ADR 0005](adr/0005-cmmc-in-scope-here.md) |
| 6 | **NIST SP 800-171 Rev 3** | watch only | CMMC is pinned to Rev 2 by 32 CFR 170.2. Rev 3 becomes relevant only if the DFARS rule moves. Do not migrate on NIST's publication date. | [ADR 0002](adr/0002-requirement-index-not-control-records.md) |
| 7 | **FY2026 NDAA §866 harmonisation** | anticipate, do not front-run | The DoD report to Congress and the consolidated framework that follows. When it lands it should attach as a crosswalk column, not a rebuild — if it cannot, ADR 0001 was wrong. | [ADR 0001](adr/0001-one-control-inventory.md) |
| 8 | **SCF identifiers on control records** | `confidence: medium` | Resolve against a locally-obtained SCF release via `scripts/import-scf.mjs`. `IAC-06` is currently carried from a reference example, not from the authority. | crosswalk `confidence` + `inherited_via_scf` |
| 9 | **FATHOM5 community 800-171 OSCAL content** | not consumed | Useful as a starting point for the requirement layer; community-sourced, so diff it against the official Rev 2 text before trusting it. Never vendor it. | [ADR 0006](adr/0006-no-framework-text.md) |
| 10 | **Control cost and FAIR-CAM measurement** | empty on every control | The enclave-versus-enterprise boundary decision moves cost by an order of magnitude, so a placeholder would be false precision. Measurement needs snapshot history that does not exist yet. | `measurement` / `cost` blocks, omitted rather than zeroed |
| 11 | **Stale CMDB records are not a finding** | by design, for now | The asset control asserts the unmanaged direction only ("no asset in the enclave ranges is absent from the inventory"). A record the CMDB holds and the cloud cannot confirm passes today. Widening it means rewriting the control assertion, not adding a reason code. | `stg_enclave_assets.sql` keeps `reconciliation_source` per row so the direction is visible even though it is not graded |
| 12 | **`evidence.retain_days` does nothing** | declared, unimplemented | It is in `schemas/config.schema.json`, defaulted in `src/config.mjs` and `src/init.mjs`, and read by no code. Either implement pruning with explicit deletion semantics, or remove the key so the config stops advertising a retention feature that does not exist. | nothing yet — a config knob that silently retains nothing |

## The general rule

Absent data is recorded as absent. An unmeasured FAIR-CAM parameter is omitted from the OSCAL props
rather than emitted as `0`, because a zero reads as "measured and found to be nothing" — a different
and much worse claim than "not yet measured". The same reasoning drives every row above.
