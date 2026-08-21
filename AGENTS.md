# Working rules for cui-control-plane

Rules for any agent or developer changing this repository. They encode decisions that were
expensive to reach; overriding one deserves a written reason, not a refactor in passing. The
load-bearing ones live in [docs/adr/](docs/adr/) — read 0001 and 0002 before touching `controls/`
or `reference/`.

## The one rule

**Never emit a claim the evidence does not support.**

Every other convention here follows from it. A compliance artifact that overstates is worse than no
artifact, because it manufactures confidence that survives until an assessor tests it. If a change
makes the numbers look better, the first question is whether it made them more true.

```bash
npm install          # also arms the commit-identity guard
npm test             # node --test "tests/*.test.mjs"
npm run validate     # schema + house rules over controls/ and models/
npm run coverage     # which of the 110 requirements have a control
npm run emit         # OSCAL O1-O5 into out/, from the fixture assertions
```

The test glob stays quoted: bare `tests/` makes Node treat the directory as a module entry and
crash, so the shell must not expand the pattern. Node >= 22.

## Invariants that must survive any refactor

1. **No model in the evidence path.** A model may draft a dbt model or summarise findings;
   deterministic code produces every pass/fail. An LLM asserting a control passed is an assessor
   objection that cannot be won.
2. **Populations, never samples.** Every control test returns the canonical assertion record with
   `total`, `failing[]` fully enumerated, `passing_count`, `as_of`, `population_definition` and
   `query_ref`. A count over a reproducible query is a population statement; the query is the
   evidence. `passing[]` stays null unless the population is small or the passing set is itself the
   artifact.
3. **`total` is a control metric.** Alert on denominator movement, not only on failures. If the
   population drifts, the asset inventory failed *before* the control did.
4. **Absent data is recorded as absent.** An unmeasured FAIR-CAM parameter is omitted from the props,
   never emitted as `0` — a zero reads as "measured and found to be nothing". Same for cost,
   objective counts, and SPRS weights.
5. **"Could not determine" is never a pass.** An unresolved manufacturer, an unreachable account, an
   unresolved affiliate: all fail, all stay in the denominator.
6. **Fixture evidence stamps every artifact generated from it**, and the stamp is set from the data,
   not passed in. Never commit real evidence to this repository.
7. **Synthetic and real evidence never share a directory.** `--fixture` runs write to a `fixture/`
   subdirectory of `evidence.path`, derived rather than configured. Two things went wrong while
   they shared one: a demo overwrote the real assertion file for that date, and — quietly, which
   was worse — prior-evidence reads dated real findings from synthetic snapshots, emitting
   fabricated variance duration unstamped at confidence tier 4. Reads filter on the stamp and
   writes refuse to cross it; do not route around either to make a demo simpler.
8. **Near-zero overlap between reconciling sources is a source error, not a finding.** Tables that
   are independent views of the same estate declare each other in `reconciles_with`, and the
   pipeline reports a pair that shares almost no identifiers. Declared rather than inferred,
   because "these two should overlap" is invisible in the data: DIBNet submissions are a
   deliberate subset of incidents, and managed endpoints share nothing with cloud resources.
   The lab case that motivated it read as 81 unmanaged assets and 68 unclassified ones; the two
   inputs shared one identifier out of 68 and were simply not about each other.
   `npm run validate` enforces the declaration itself, because every way of getting it wrong makes
   the check quietly not apply: a typo names no table, an asymmetric pair is seen from one side
   only, and a `subject_key` outside `required` lets a source load without that column, compare two
   empty identifier sets, and report agreement. Silence there is indistinguishable from consensus.
9. **`evidence.retain_days` is a floor, and nothing deletes evidence.** It commits to keeping at
   least that much history, the way retention periods read everywhere else in this domain.
   Read as a delete-after trigger the same number would flatter every control: `firstObserved`
   walks history backwards to the last passing snapshot, so dropping the oldest snapshots
   shortens every open variance episode. A subject failing across 600 days of monthly snapshots
   reports 180 days once pruned to a 180-day window — a 70% understatement of Variance
   Duration, feeding FAIR-CAM and the risk layer with nothing marking it. `ccp doctor` measures
   the span held against the commitment; a test asserts no deletion call exists anywhere in
   `src/`. If retention ever does prune, it owes left-censoring first.
10. **The primary checkout is not a working tree.** `.githooks/pre-commit` refuses commits there;
    work happens in a linked worktree, one per session. Two sessions sharing this checkout on
    2026-08-20 rewrote CLAUDE.md mid-edit, emptied `.evidence/` between two commands, changed
    source files under a read, and swept unfinished Terraform into a `git add -A`. None of it was
    a conflict, so git had nothing to report — which is why this is a hook and not a convention.
    `node ~/.claude/scripts/worktree.mjs add cui-control-plane <branch>` makes one and bootstraps
    it; `ALLOW_PRIMARY_COMMIT=1` is the deliberate exception. Note the hook only binds once armed
    by `npm run setup`, and `core.hooksPath` is relative, so `.githooks/` must stay tracked or a
    worktree silently runs no hooks at all.

## Control records (ADR 0001, ADR 0002)

- IDs are `ctl.<domain>.<layer>.<control>`, **stable and never reused**. Renaming is a new ID plus a
  `supersedes` edge — a rename changes every derived UUID.
- Assertion text is ours and quantifies over a population ("every…", "no…"). A test enforces the
  quantifier. This is the highest-value writing in the repository and it is not a technical task.
- **Frameworks attach as crosswalk edges: identifier + `confidence` + `basis` only.** Never
  reproduce framework text, and never generate content derived from SCF — its CC BY-ND licence
  names AI-generated derivative content specifically. SCF identifiers as crosswalk anchors are fine.
- A `confidence: low` edge is **not** coverage. It shows as `weak` and the SPRS derivation ignores it.
- Splitting by layer is the discipline; over-splitting is the counter-discipline. If two things
  share an owner, a cost, a failure mode *and* a piece of evidence, they are one control with two
  crosswalk edges. Any split states which of those four differs, in `split_rationale`.
- `policy_ref` requires `status: operating`. Policy last, always, and generated.

## Adding a control

1. Write the record in `controls/`, with `population_definition`, `source_system` and `query_ref`
   filled from the start — never policy text first.
2. Write the dbt model at the `query_ref` path. Its header **must** carry the
   `population_definition (must match the where clause below)` block; the validator compares that
   restatement against the record and refuses drift. The `where` clause *is* the population.
3. Union it into `models/intermediate/control_results_all.sql`. The list is explicit rather than
   macro-generated so that forgetting is a visible one-line diff — a control model outside that
   union produces assertions and no VF/VD.
4. Add a fixture assertion under `fixtures/assertions/`, stamped `"fixture": true`, with counts that
   reconcile and `failing[]` fully enumerated.
5. `npm run validate && npm test`.

## Generated files are generated

`reference/nist-800-171r2.index.yaml`, `reference/sprs-weights.yaml` and
`fixtures/sprs-weights.fixture.yaml` come from `scripts/gen-requirement-index.mjs`. A test re-runs
the generator and diffs, so a hand edit fails CI. Change the generator.

## The two constants that must never move

`PROPS_NS` and `UUID_NS` in `src/lib/ns.mjs`. Rotating either silently reassigns every identifier in
every artifact ever emitted. `tests/uuid.test.mjs` pins the derivation.

## Verified vs. unverified

`docs/watch-items.md` is the list of things this repository does not assert. When one gets settled,
set `verified: true` in the relevant file and delete the row — but only after reading the primary
source. The refusals in `src/sprs.mjs` and the warning in `src/oscal/poam.mjs` exist so that
"nobody checked" cannot be mistaken for "checked and empty"; do not route around them to make a
demo produce a nicer number.

## Git and GitHub

- **Every commit** uses author `RootCawsLLC <317738477+RootCawsLLC@users.noreply.github.com>`. The
  account blocks pushes exposing the private address, so a wrong author means rewriting history;
  `.githooks/pre-commit` refuses the commit instead. Hooks and local config do not survive a clone,
  so `scripts/setup-git.mjs` arms them from npm's `prepare` hook on `npm install`.
  Verify with `git config core.hooksPath` (expect `.githooks`).
- Merge PRs with `gh pr merge --rebase`, never `--squash`: a squash attributes the squash commit to
  the PR author and writes a personal identity into public history.
- Pushing from an `xnasusx` clone needs the credential helper reset, or Git Credential Manager
  serves the RootCawsLLC credential and the push 403s:
  `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push`
