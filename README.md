# cui-control-plane

One control inventory for a DoD CUI boundary. Five NDAA-driven regimes attach to it as crosswalk
edges rather than as five compliance programmes. The pipeline that produces the assessment package
also produces Variance Frequency and Variance Duration on every control, which is what makes it a
risk instrument rather than a compliance cost centre.

## Start here

```bash
npm install
npm run pipeline
```

That collects from bundled fixtures, builds a local DuckDB warehouse, evaluates every control and
writes assertion records. **No Python, no warehouse, no credentials, nothing contacts a real
system.** Five controls assert and one is withheld — and the withheld one is the point: no collector
populates its source, so the tool refuses to say anything rather than reporting 0 of 0 passing.

Then make it yours:

```bash
npm run init      # twelve questions, every one with a working default
npm run doctor    # what is configured, what is missing, which controls will be withheld
```

**[docs/SETUP.md](docs/SETUP.md) is the guided walkthrough** — the three decisions only you can
make, how to wire your first real source, and exactly what needs customising.

Everything under `fixtures/` is synthetic and stamped `NOT REAL EVIDENCE`; every artifact generated
from it carries the stamp through, and the SPRS scorer refuses to call the result submittable.

## The framing

The National Defense Authorization Act is enabling legislation. It authorises and directs
rulemaking; it does not specify controls, evidence, or assessment mechanics. "NDAA compliance"
resolves to five independently-implemented regimes, plus one adjacent statute that is routinely
conflated with them:

| Regime | Statutory driver | Implementing rule | What it demands |
|---|---|---|---|
| CMMC 2.0 Level 2 | FY2020 NDAA | DFARS 252.204-7021 / 32 CFR Part 170 · NIST SP 800-171 **Rev 2** | Assessment, SPRS score, POA&M with a closeout clock |
| Safeguarding CDI + incident reporting | pre-dates the NDAA | DFARS 252.204-7012 | 72-hour DIBNet report **from discovery**, 90-day image preservation, DC3 malware submission, flow-down |
| Covered telecom / video surveillance | FY2019 NDAA §889 | FAR 52.204-24 / -25 | Annual representation of no covered use |
| Chinese Military Companies list | FY2021 NDAA §1260H | DoD-published list + implementing clause | No contracting with a listed entity; supply-chain diligence to catch affiliates |
| Cyber requirement harmonisation | FY2026 NDAA §866 | forthcoming | Anticipate, do not front-run — be crosswalk-ready |
| *(adjacent)* Supply chain security | FASCSA 2018 — **not an NDAA section** | FAR subpart 4.23 | FASC exclusion and removal orders |

Building five parallel programmes against those would produce five populations of the same assets,
five evidence collections, and no way to answer "how exposed are we" across any of it. So the whole
repository is organised around **one** control inventory that each regime crosswalks into —
[ADR 0001](docs/adr/0001-one-control-inventory.md).

## What is here

```
ccp.config.yaml      THE ONE FILE YOU EDIT (gitignored; `npm run init` writes it)
inbox/               drop CSV exports here - the universal adapter, no credentials needed
src/collectors/      Entra ID, Azure Resource Graph, and CSV for everything else
src/warehouse.mjs    DuckDB + a dbt shim, so the models run without Python
src/pipeline.mjs     collect -> load -> build -> assert
controls/            the inventory - one YAML record per control
scenarios/           the join to risk - loss events, no numbers until there are numbers
exceptions/          reduced coverage with an expiry, never a pass
reference/           requirement identifiers and SPRS weights. Identifiers only, never framework text
models/              dbt: staging -> controls (one model per control_id) -> variance
src/oscal/           O1 component definition, O2 catalog + profile, O3 plan + results, O4 POA&M, O5 SSP
src/variance.mjs     VF and VD from assertion history - the risk half
src/sprs.mjs         SPRS derived from assertion records - and the refusals that keep it honest
src/policy.mjs       policy generated from OPERATING controls only
src/representation.mjs   the Section 889 representation, regenerated rather than re-collected
fixtures/            synthetic assertion records, a time series, all stamped NOT REAL EVIDENCE
docs/adr/            the decisions that were expensive to reach
```

### The control inventory

Six controls ship: the five the plan names, plus the layer-split counterpart that demonstrates the
discipline.

| control_id | Status | Why it exists |
|---|---|---|
| `ctl.cui.boundary.asset-inventory` | building | The denominator for every other CUI-scoped control |
| `ctl.iam.cui-enclave.mfa` | building | Highest scenario weight, cleanest telemetry — the first evidence target |
| `ctl.iam.corp-it.mfa` | planned | **Out of the assessment boundary on purpose** — see below |
| `ctl.scrm.procurement.entity-list-screening` | planned | §1260H and FASC orders over the supplier master |
| `ctl.scrm.procurement.telecom-equipment-attestation` | planned | §889 over the component inventory |
| `ctl.ir.dibnet.incident-reporting` | planned | The 72-hour DFARS 7012 process control |

**`status` is the control's lifecycle in the environment, not this repository's build progress.**
All six have a record, a population definition, a dbt model and a crosswalk — that is how a control
gets planned. None is `operating`, because nothing is yet instrumented against real telemetry and
observed holding: there is no warehouse, no enclave IdP and no supplier master here. `planned`
means sequenced for later, and the two marked `building` are the Phase 2 order — the denominator
first, then the highest-weight control with the cleanest telemetry.

That field is load-bearing rather than decorative. It is why `ccp coverage` reports **0 operating**,
and why `ccp policy` generates nothing: policy comes last, generated from a control observed
holding. Advancing it optimistically would make both of those lie.

**The MFA split is the worked example of the hardest discipline in the practice.** An assessor
scores the CUI boundary specifically. One "MFA" record spanning the enclave and corporate IT is the
munged control that makes an SSP indefensible under review — and it would import corporate-IT
failures into an SPRS score they have nothing to do with. So there are two records, each stating
which of owner / cost / threat model / failure mode differs, and `ctl.iam.corp-it.mfa` deliberately
claims **no** 800-171 requirement. The validator refuses either one without a `split_rationale`.

## What the code refuses to do

The interesting part of this repository is the set of things it will not emit.

- **`ccp sprs` refuses to compute a score while any weight is null.** The 5/3/1 scheme and the two
  partial-credit rules are structural and encoded; the per-requirement weight table is published in
  the DoD Assessment Methodology and is shipped here unpopulated. A guessed weight produces a wrong
  score, a wrong score is submitted to a Government system of record, and it is indistinguishable
  from a right one by inspection.
- **An unresolved manufacturer fails.** It is not dropped from the denominator and it does not pass
  by default: "we could not tell" is the one answer that must never be scored as "no".
- **A supplier screened against a superseded list edition fails.** The §1260H list changes on a
  recurring cadence, so clean-last-quarter is not screened.
- **OSCAL findings are never rounded up.** Three failures out of 1,842 is `not-satisfied`, because
  the enum has no partial state; the population counts ride along in props so a reader can see the
  proportion the vocabulary cannot express.
- **`variance_started_at = variance_detected_at` is disclosed, never assumed.** Every artifact
  reporting a duration derived from it says the reliability is an upper bound.
- **A `policy_ref` on a control that is not operating is refused.** Build the control, instrument
  it, observe it holding, then generate the expectation from it.
- **Fixture evidence stamps everything downstream.** Title and remarks both say `NOT REAL EVIDENCE`.
- **`ccp policy` generates nothing while no control is operating**, and names every control it
  skipped with its status. A policy for a control that is not yet holding is a Defined Expectations
  control with no Loss Event Control behind it — documented misalignment, not risk reduction.
- **`ccp representation 889` refuses to draft an affirmative representation** while any component
  is unresolved. False Claims Act exposure attaches to the representation itself, so "we could not
  determine the manufacturer of three components" is a basis for representing *nothing yet*, never
  for representing that no covered equipment is used.
- **`ccp variance` will not annualise a fortnight into a rate** without labelling it extrapolation,
  will not average away censored episodes, and reports the queue regime instead of a mean once
  remediation saturates.

Each of those is a test in `tests/guards.test.mjs` or `tests/emit.test.mjs`, because a guard nobody
has watched fail is a guard nobody knows is running.

## The risk half

`ccp variance` derives Variance Frequency and Variance Duration per control from the assertion
history — the conversion that makes this a risk instrument rather than a compliance pipeline. VF and
VD feed control reliability, which is an input to loss event frequency for the scenarios in
`scenarios/`.

Three things it gets right that are easy to get wrong: **censored episodes** are counted and
excluded from the mean with the exclusion stated, because the long-running failures are exactly the
ones still open and dropping them biases VD downward; **queue saturation** is reported as a regime
rather than a mean, because past roughly 0.7 utilisation duration goes non-linear; and **short
windows** are labelled extrapolation, because five episodes in a fortnight annualising to 130/year
is arithmetic, not measurement. A single snapshot gets no frequency at all — it is a photograph, not
a history.

The scenarios themselves stay unquantified. Structure is there — loss event, threat community,
asset, effect, loss forms — and `quantification` is null with an explicit `blocked_on`, because
nothing here has the loss data to fill it and a range with no provenance must not read as
authoritatively as a sourced one.

## Deterministic artifacts

Every UUID is RFC 4122 **v5** over a committed namespace, keys are sorted recursively, and
`last-modified` is derived from the newest `as_of` in the evidence rather than from the clock. An
unchanged inventory re-exports **byte-identically**, so the assessment package is reviewable as a
Git diff instead of a blob that changes every run — the direct answer to the strongest published
criticism of OSCAL. `tests/emit.test.mjs` asserts it rather than claiming it, and the v5
implementation is pinned to the published RFC test vector.

**All eight artifacts validate against NIST's own `oscal-cli`, as a blocking CI gate** — catalog,
both profiles, component definition, assessment plan, assessment results, POA&M and SSP. That gate
earned its keep immediately: it caught six defects nothing else would have, including `#assessment-plan`
as a document reference (OSCAL resolves `#…` fragments *as UUIDs* and follows them), `item` parts at
the top level of a control, and `with-ids` profile syntax used where the assessment models require
`control-id`. None of those are visible by reading the JSON. An earlier version of that job invoked a
package name that does not exist on npm and piped it through `|| true`, reporting green while
validating nothing — which is why the comment above it now says what it does.

This differs from `ksi-harness`, which truncates a SHA-256 into a v4 shape. That is stable within
one repository; v5 is stable across any RFC 4122 implementation, so an assessor can recompute our
identifiers independently. [ADR 0003](docs/adr/0003-deterministic-uuids.md).

## Framework text

**Identifiers and our own reasoning. Never framework text.** SCF is CC BY-ND and its terms name
AI-generated derivative content specifically; AICPA and ISO material is copyright; and a hand-copied
requirement goes stale while continuing to read as current. NIST SP 800-171 is public domain and is
still excluded, because the assertion text is ours and a paraphrase of somebody else's requirement
is not. SCF content is resolved at run time from a local release and never vendored.
[ADR 0006](docs/adr/0006-no-framework-text.md).

## Read next

- [docs/plan.md](docs/plan.md) — the phased implementation plan
- [docs/watch-items.md](docs/watch-items.md) — what this repository deliberately does not assert
- [docs/adr/](docs/adr/) — including [why CMMC is in scope here](docs/adr/0005-cmmc-in-scope-here.md)
  when `ksi-harness` ADR 0004 declared it out of scope there
- [AGENTS.md](AGENTS.md) — working rules for anyone changing this code

## Licence

Apache-2.0. No third-party framework content is vendored or redistributed.
