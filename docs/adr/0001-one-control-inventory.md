# ADR 0001 — One control inventory, five regimes as crosswalk edges

**Status:** accepted · **Date:** 2026-08-19

## Context

"Build a GRC engineering solution for NDAA compliance" does not resolve to one thing. The National
Defense Authorization Act is enabling legislation: it authorises and directs rulemaking, and does
not itself specify controls, evidence, or assessment mechanics. What a DoD prime handling CUI
actually faces is five distinct, independently-implemented regimes, plus one adjacent statute that
is routinely conflated with them:

| Regime | Statutory driver | Implementing rule |
|---|---|---|
| CMMC 2.0 Level 2 | FY2020 NDAA | DFARS 252.204-7021 / 32 CFR Part 170, requirements body NIST SP 800-171 Rev 2 |
| Safeguarding CDI + incident reporting | pre-dates the NDAA, reinforced since | DFARS 252.204-7012 |
| Covered telecom / video surveillance | FY2019 NDAA §889 | FAR 52.204-24 / -25 |
| Chinese Military Companies list | FY2021 NDAA §1260H, amended since | DoD-published list plus implementing clause |
| Cyber requirement harmonisation | FY2026 NDAA §866 | forthcoming consolidated framework |
| *(adjacent, not an NDAA section)* Federal Acquisition Supply Chain Security Act | FASCSA 2018 | FAR subpart 4.23, FASC exclusion orders |

The obvious response — one programme per regime — is wrong in a way that is expensive and slow to
undo. It produces five populations of the same assets, five evidence collections, five sets of
drift, and no way to answer "how exposed are we" across any of it.

## Decision

**One canonical control inventory. Every regime is a crosswalk edge onto it, never a track of its
own.** Framework requirements, risk scenarios, policy paragraphs, POA&M items and control tests are
all foreign keys to a `control_id`. If something cannot resolve to a `control_id`, it is not a
first-class object in this model.

Concretely:

- `controls/` holds the inventory. One YAML record per control, `ctl.<domain>.<layer>.<control>`.
- Regimes attach through `crosswalk[]`, each edge carrying an identifier, a **confidence**, and a
  **basis** — our stated reasoning, so a reviewer can disagree with it.
- Three new domains join the standard set for this problem: `ctl.cui.*` (boundary definition,
  marking, inventory), `ctl.scrm.*` (entity-list screening, telecom attestation), `ctl.ir.*`
  (DFARS 7012 detection and reporting).
- The §1260H screening control and the FASC screening obligation are **one control**, because
  operationally they ask the same population question of the same supplier master. The two
  *authorities* are named separately and never conflated in prose — see the crosswalk on
  `ctl.scrm.procurement.entity-list-screening`.

## Consequences

- Adding a regime is a crosswalk column, not a programme. This is the concrete payoff when §866
  harmonisation lands: whatever DoD's consolidated framework turns out to be, it attaches to
  controls that already exist.
- The supplier master is built **once**, in Phase 0, and serves both the §1260H control and the
  §889 control. Neither owns it.
- A crosswalk edge with `confidence: low` does **not** count as coverage. `ccp coverage` reports it
  as `weak` and the SPRS derivation ignores it. An over-confident crosswalk an assessor relies on is
  worse than an absent one.
- The inventory will contain controls no assessor scores — `ctl.iam.corp-it.mfa` is the worked
  example. That is correct: the business carries the risk regardless of who scores it. See
  ADR 0005.
