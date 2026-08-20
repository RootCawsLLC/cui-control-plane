# ADR 0004 — The SSP is generated; the POA&M carries variance timestamps

**Status:** accepted · **Date:** 2026-08-19

## Context

Two artifacts decide how a CMMC assessment goes, and both are usually authored by hand in a word
processor and then maintained against reality by willpower.

**The SSP.** Assessors weight SSP-to-reality drift heavily, and drift is the default state of a
hand-authored document describing a system that changes daily. Every hour spent hand-editing an SSP
is an hour spent creating the exact defect the assessment looks for.

**The POA&M.** Conventionally it says "this is broken, here is a target date". That is a compliance
artifact. It carries no information about how long the control has been broken, how long it took to
notice, or how long it sat before anyone acted — which is the information that would tell you
whether the problem is monitoring, prioritisation, or capacity.

## Decision

**The SSP is generated from catalog + profile + component definitions, never hand-authored.**
`src/oscal/ssp.mjs` derives every statement from the control records: scope from
`population_definition`, requirement from `title` and the FAIR-CAM function, owner from `owner`, and
the current exception set from the live `failing[]`. A generated SSP cannot drift from the controls
it was generated from, by construction.

If this file is ever edited by hand, the edit is a bug. `tests/emit.test.mjs` asserts the output is
a pure function of the control records plus the assertion set, and that every statement restates its
control record rather than introducing new prose — which makes that claim checkable rather than a
note in a README.

**The POA&M is generated from `failing[]`, carrying the four variance timestamps.** Each item ships
`variance_started_at`, `variance_detected_at`, `remediation_started_at`, `remediation_completed_at`
and the `started_at_basis`, plus the three derived segments:

| Segment | FAIR-CAM function | The fix is a… |
|---|---|---|
| started → detected | Control Monitoring | cadence / coverage problem |
| detected → remediation started | Treatment Selection & Prioritisation | prioritisation / ownership problem |
| remediation started → completed | Implementation | capacity / tooling problem |

That converts the POA&M from a compliance artifact into a risk artifact carrying VF and VD.

**The 180-day closeout is not a compliance calendar.** It is a Variance Duration SLA computed from
the same timestamps as every other control, and it appears on each POA&M item as days open against
the window. The 72-hour DFARS clock is the same shape, measured from `variance_detected_at` because
that is where the clause legally starts it.

## Two refusals encoded in the generator

1. **A requirement on the non-POA&M-able list cannot become a POA&M item, at any score.** That list
   currently lives in `reference/nist-800-171r2.index.yaml` as `verified: false` with an empty
   identifier set, and the generator **warns loudly** rather than passing silently — an empty
   unverified list means nobody checked, which is not the same as there being nothing to check.
   Verify it against the live 32 CFR Part 170 text.
2. **Fixture evidence stamps every artifact generated from it.** Title and remarks both carry
   `NOT REAL EVIDENCE`, and the SPRS scorer refuses to call the result submittable. A fixture
   package that reads as real is the most damaging thing this repository could produce.

## Consequences

- Policy comes last and is generated too. A `policy_ref` on a control whose status is not
  `operating` is refused by the validator: build the control, instrument it, observe it holding,
  *then* generate the expectation from it.
- The SSP will contain honest gaps — controls with no assertion yet say so explicitly rather than
  describing an intended state. That is the correct behaviour for a greenfield build and it is much
  better to hand an assessor than confident prose about something not yet running.
- OSCAL's finding vocabulary is `satisfied` / `not-satisfied` and nothing else. Three failures out
  of 1,842 is reported as `not-satisfied`, never rounded up; the population counts ride along in
  props so a reader can see the proportion the enum cannot express.
