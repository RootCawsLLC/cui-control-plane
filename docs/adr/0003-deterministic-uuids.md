# ADR 0003 — RFC 4122 v5 UUIDs over a fixed namespace

**Status:** accepted · **Date:** 2026-08-19

## Context

The strongest published criticism of OSCAL is that the format makes collaboration and review
difficult. Most of that criticism is really about one implementation detail: tools emit random
(v4) UUIDs, so every export of an unchanged system produces a different file. The diff is noise,
review is impossible, and the artifact cannot meaningfully live in Git.

For a CMMC engagement this matters more than usual. The assessment package is reviewed, argued
with, and revised. A package that changes wholesale on every regeneration cannot be reviewed as a
diff, which means it gets reviewed as a document, which means it gets hand-edited — and a
hand-edited SSP is the defect the whole architecture exists to prevent (ADR 0004).

## Decision

Every UUID is **RFC 4122 v5** (SHA-1, name-based) over a fixed namespace, with the stable natural
key as the name.

```
UUID_NS  = fe257ac3-9522-5d89-bdc1-242daee59e92
         = uuid5(NS_URL, "https://github.com/RootCawsLLC/cui-control-plane/ns")

component               = uuid5(UUID_NS, control_id)
implemented-requirement = uuid5(UUID_NS, `${control_id}|${framework}|${item}`)
assessment result       = uuid5(UUID_NS, `${control_id}|${as_of}`)
```

Both constants are committed in `src/lib/ns.mjs` and **never rotated** — rotating either silently
reassigns every identifier in every artifact ever emitted.

Three supporting decisions make byte-stability actually hold:

1. **Keys are sorted recursively** before serialization (`sortKeys` in `src/oscal/common.mjs`), so
   construction order cannot leak into the output.
2. **`last-modified` is derived from the evidence, not the clock.** It is the newest `as_of` in the
   assertion set, or the epoch when there is none. Using `Date.now()` here would make every export
   differ and would render the v5 UUIDs pointless.
3. **Records are sorted by natural key, not by filename**, so renaming a file cannot reorder an
   export.

`tests/emit.test.mjs` asserts every artifact re-exports byte-identically and that every UUID in the
emitted package matches the v5 shape.

## Why v5 rather than the ksi-harness approach

`ksi-harness` produces stable identifiers by truncating a SHA-256 into a v4-shaped string. That
achieves stability within that repository, and it was the right call for a tool whose output format
is FedRAMP's own JSON rather than OSCAL.

It is not enough here. Those identifiers are not v5, so **no other implementation given the same
namespace and name reproduces them**. An assessor with any RFC 4122 library can recompute the
UUIDs in this package and get the same answer — that is a property a third party can check, and it
is worth the twenty lines of hand-rolled SHA-1 in `src/lib/uuid5.mjs`. The implementation is pinned
to the published RFC test vector in `tests/uuid.test.mjs`.

## Consequences

- Node ships no v5 implementation (`crypto.randomUUID` is v4), so this is hand-rolled. The RFC
  vector test is what makes that safe.
- A control rename is a new UUID. That is correct and is why control IDs are stable and never
  reused: renaming is a new ID plus a `supersedes` edge, not an edit.
- `out/` is gitignored here because this is a reference repository. In an engagement repo, commit
  it — the whole point is that the diff is readable.
