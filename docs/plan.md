# Implementation plan — NDAA-driven compliance for a DoD CUI boundary

Scope: DoD prime or subcontractor handling CUI, greenfield build. Phases overlap deliberately;
the dependency column is the real constraint, not the week numbers.

The framing is in [ADR 0001](adr/0001-one-control-inventory.md): the NDAA is enabling legislation,
not a control framework, and "NDAA compliance" resolves to five regimes plus one adjacent statute.
This plan builds **one** control inventory that each of them crosswalks into.

---

## Phase 0 — Scoping (weeks 1–3)

Produces the one decision everything else depends on: **the CUI boundary.**

CMMC assessment cost, control count and SSP defensibility all follow from whether CUI is isolated
to a defined enclave or spread across the general enterprise. **Recommend the enclave approach**
unless the business case for full-enterprise scope is explicit — it is what keeps the layer-split
discipline from collapsing into "certify everything."

Alongside the boundary decision:

- **Inventory existing and pipeline contracts** for the presence of the 252.204-7012 and
  252.204-7021 clauses. The obligation may already be active on paper even where no control exists
  yet to satisfy it.
- **Stand up the supplier/subcontractor master.** This one dataset is the population for both the
  §889 and the §1260H controls in Phase 1. Build it once; neither control owns it.
- **Register the FAIR-CAM props namespace.** Already done — `https://github.com/RootCawsLLC/cui-control-plane/ns`,
  pinned in `src/lib/ns.mjs` with the derived UUID namespace. Retrofitting it later means
  re-exporting everything, which is why it is a Phase 0 item and not an OSCAL detail.

## Phase 1 — Control architecture (weeks 2–8, overlapping)

Three new domains join the standard set (`iam`, `data`, `network`, `endpoint`, `appsec`, `logging`,
`change`, `vendor`, `bcdr`, `people`):

- `ctl.cui.*` — boundary definition, marking and handling, asset inventory
- `ctl.scrm.*` — entity-list screening, telecom-equipment attestation
- `ctl.ir.*` — DFARS 7012 incident detection and reporting

**The layer split matters more here than almost anywhere else it is applied.** An assessor scores
the CUI boundary specifically, so a control like "MFA" spanning the enclave and general corporate
IT as one entry is exactly the munged control that makes an SSP indefensible under review — and it
would import corporate-IT failures into an SPRS score they have no business affecting.
`ctl.iam.cui-enclave.mfa` and `ctl.iam.corp-it.mfa` ship as the worked example; the validator
refuses either one without a stated `split_rationale`.

Build order:

1. **The requirement index** — 110 identifiers, fourteen families, generated and checked
   ([ADR 0002](adr/0002-requirement-index-not-control-records.md)). Assessment target, not
   inventory.
2. **The five novel controls**, each with a real `population_definition` and `query_ref` from day
   one, never written as policy text first:
   - `ctl.cui.boundary.asset-inventory` — the Decision Support Control everything else's population
     depends on
   - `ctl.iam.cui-enclave.mfa` — first evidence target, see Phase 2
   - `ctl.scrm.procurement.entity-list-screening` — supplier master vs. the published 1260H list
     and FASC orders
   - `ctl.scrm.procurement.telecom-equipment-attestation` — component inventory vs. covered
     manufacturers
   - `ctl.ir.dibnet.incident-reporting` — the 72-hour DFARS 7012 process control
3. **SCF crosswalk resolution** — `scripts/import-scf.mjs` against a locally-obtained release. SCF's
   crosswalk set already includes 800-171, so SOC 2 / ISO / CSF edges for anything else in scope are
   inherited rather than hand-built. Never vendored ([ADR 0006](adr/0006-no-framework-text.md)).
4. **OSCAL O1 and O2** — component definitions and catalog + profile, with deterministic v5 UUIDs
   from the very first export ([ADR 0003](adr/0003-deterministic-uuids.md)).

## Phase 2 — Evidence pipeline (weeks 6–14, overlapping)

**First control, in order.** `ctl.cui.boundary.asset-inventory` is not optional to go first — it is
the denominator for the entire CUI-scoped assessment, and if that population drifts then everything
downstream failed before its own control did. **Second:** `ctl.iam.cui-enclave.mfa` — highest
scenario weight (credential theft against systems holding CUI) with the cleanest available telemetry
(enclave IdP API). One system, one control, one cycle, then compound.

Source systems — the standard set plus two this domain genuinely requires:

| Layer | Source | Note |
|---|---|---|
| CUI enclave identity | Okta / Entra ID, enclave tenant | Population is human identities in the enclave IdP, excluding service principals |
| Cloud posture | AWS GovCloud Config / CloudTrail | History-native; pair with a current-state tool as usual |
| Asset / CMDB | whatever inventories the boundary today | If nothing does, that is the Phase 0 deliverable, not a Phase 2 assumption |
| Change management | Git + CI APIs scoped to CUI-touching repos | Branch protection settings *are* the control |
| Endpoint | EDR/MDM on enclave-managed devices | Define "variant" explicitly — stale agent by how long? |
| **Supplier / entity screening** *(new)* | Vendor master + published §1260H list as a reference table | Full diff, never a sample. The list changes on a recurring cadence, so schedule the refresh like any other extract |
| **Telecom attestation** *(new)* | Hardware inventory or SBOM/HBOM vs. covered-equipment list | Same population-diff pattern one level down: components rather than counterparties |

dbt layout extends the standard pattern directly — one model per `control_id`, `where` clause
matching the documented population, nothing new conceptually. The population restatement in each
model header is checked against its control record by `ccp validate`; drift between them is a
finding.

**The DFARS 7012 control is the one genuinely different shape** — event-triggered rather than
continuously sampled — but the four variance timestamps map onto it directly and turn the 72-hour
SLA into something measured instead of assumed:

```
variance_started_at      = incident occurrence (or best available proxy)
variance_detected_at     = internal discovery          <- the clock the clause starts from
remediation_started_at   = IR triage begins
remediation_completed_at = DIBNet submission accepted
```

`variance_started_at` for a security incident is rarely known precisely at occurrence. Use the
source system's own earliest indicator where available, and **disclose explicitly** when
`remediation_completed_at − variance_detected_at` is being reported instead of the full window,
since the DFARS clock legally starts at discovery, not at true onset. The `started_at_basis` field
carries that disclosure through every artifact rather than leaving it to a footnote.

## Phase 3 — Attestation and assessment readiness (weeks 10–16)

The plan called for O3, O4 and O5. It turned out to need an **assessment plan** as well: OSCAL
follows `import-ap` rather than merely recording it, so assessment results without one is an
incomplete object graph and NIST’s validator says so. It is minimal by design — the plan is
"run the control models over their full populations on their stated cadence", because there is no
sampling design to describe. The assessment plan for a query is the query.

- **SSP generated, never hand-authored** (O5). The highest-leverage single decision in the plan for
  a CMMC engagement — see [ADR 0004](adr/0004-generated-ssp-and-poam.md).
- **POA&M generated from `failing[]`** (O4), carrying the four variance timestamps so it reads as a
  risk artifact rather than a compliance checklist. Confirm the non-POA&M-able requirement subset
  against the live 32 CFR Part 170 text before relying on it — several 800-171 requirements cannot
  be POA&M'd regardless of score, and that list is worth verifying directly rather than from memory.
  It is tracked as unverified today and the generator warns.
- **SPRS score as a derived output**, computed from the assertion records — not a spreadsheet
  exercise. The scorer refuses to run against unpopulated weights
  ([ADR 0007 rationale lives in `src/sprs.mjs`](../src/sprs.mjs)).
- **The 180-day POA&M closeout and the 72-hour DFARS clock are both just Variance Duration SLAs**
  the pipeline already computes for every other control. Treated identically, not tracked on a
  separate compliance calendar.
- **Policy last, as always.** CUI handling and incident-response policy are generated from the
  operating control definitions once they are observed holding — not authored ahead of the controls
  to satisfy a document checklist. The validator enforces this.

## Phase 4 — Ongoing operations and forward-fit

- **§1260H list monitoring** is a recurring scheduled extract-and-diff against the supplier master,
  not a one-time screening. The list has already grown once this year and will again — which is why
  "screened against a superseded edition" is a control failure here and not a data-quality note.
- **§889 annual representation regenerates** from the live telecom-equipment attestation control
  instead of being re-collected as a standalone form each year.
- **§866 harmonisation** is the argument for having built on crosswalked canonical controls in the
  first place: whatever DoD's consolidated framework turns out to be, it lands as a new crosswalk
  column against controls that already exist, not a rebuild. That is worth saying explicitly to
  whoever is funding this.

## Sequencing

| Weeks | Work | Depends on |
|---|---|---|
| 1–3 | CUI boundary decision, contract clause inventory, supplier master, props namespace | — |
| 2–8 | Control records, SCF crosswalk, OSCAL O1/O2 | Boundary decision |
| 6–14 | Pipeline: asset inventory → MFA → remaining IAM/data/network → entity screening → telecom attestation → IR | Control records |
| 10–16 | OSCAL O3, O4, O5 and SPRS scoring | Pipeline producing assertions |
| Ongoing | List monitoring, representation regeneration, harmonisation crosswalk maintenance | Everything above operating |

## What this buys beyond the assessment

The same pipeline that produces the assessment package also emits Variance Frequency and Variance
Duration on every control, which are direct inputs to loss event frequency for the scenarios that
actually matter here — a CUI breach, a missed 1260H screening, an undetected covered-telecom
component. That is the difference between building this as a compliance cost centre and building it
as a risk instrument that happens to also satisfy an assessor.

If quantifying those scenarios becomes useful — sizing exposure from a CUI incident, or prioritising
which of the 110 requirements to harden first by risk-reduction-per-dollar — that work picks up
directly from the assertion records this plan produces, with no re-architecture. The `cost` and
`measurement` blocks on each control record are the hooks; they are deliberately empty rather than
guessed.
