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
