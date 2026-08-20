# Setup

You have been asked to "automate NDAA compliance." This gets you from a clone to a working
evidence pipeline, and tells you exactly which decisions are yours to make.

Read time: 15 minutes. First real run: an afternoon. Nothing here needs Python, a warehouse, a
budget, or a ticket to another team.

---

## Step 0 — Run it before you change anything (5 minutes)

```bash
npm install
npm run pipeline
```

That collects from bundled fixtures, builds a local DuckDB warehouse, evaluates every control model
and writes assertion records to `.evidence/`. Nothing contacts a real system.

You should see five controls asserted and one **withheld**. The withheld one matters more than the
five: no collector populates its source, so the tool refuses to say anything about it rather than
reporting 0 of 0 passing. **An unestablished population is never a pass** is the rule the whole
thing is built on, and that is what it looks like.

Then look at the rest of the chain:

```bash
npm run emit -- --assertions .evidence   # OSCAL O1-O5, validated against NIST's schemas
npm run variance                          # Variance Frequency and Duration
npm run coverage                          # which of the 110 requirements have a control
```

If that all worked, the machinery is fine and everything from here is about pointing it at your
organisation.

## Step 1 — Make it yours

```bash
npm run init
```

Twelve questions, every one with a working default and a stated reason. It writes `ccp.config.yaml`,
which is **the only file you edit**. It is gitignored, because it describes your boundary and your
systems and should live in your repository, not upstream.

## Step 2 — Ask what is missing

```bash
npm run doctor
```

`doctor` is the command you will run most. It tells you what is configured, what is missing, which
environment variables it wants, and — the important part — **which controls will be withheld** and
why. Every warning comes with the thing to do about it.

Run it after every change. It is designed to be the answer to "am I set up yet?"

---

## Step 3 — The three decisions only you can make

Everything else has a default. These do not.

### 1. The CUI boundary — `boundary.approach`

**Enclave** isolates CUI to a defined set of systems. **Enterprise** puts your whole estate in
scope. This one decision drives assessment cost, control count, and how defensible your SSP is.

Pick `enclave` unless someone has explicitly decided and funded otherwise. If you genuinely do not
know yet, that is the finding to take to your leadership — and it is Phase 0 work, not a config
value to guess.

### 2. The supplier master

One list of every supplier and subcontractor. It is the population for **both** the Section 1260H
screening control and the Section 889 attestation. Build it once.

You do not need an API. Export from your ERP or procurement system to CSV. Required columns:

```
supplier_id,legal_name,relationship_status
```

Optional but useful: `country_of_incorporation`, `handles_cui`, `parent_supplier_id`,
`last_screened_at`. Drop it at `inbox/suppliers.csv`.

### 3. The Section 1260H list

**This repository does not ship it, and will not.** The list changes on a recurring cadence, and a
stale copy is worse than none — a supplier screened against last quarter's edition reads as
"screened" when it is not. The control fails a supplier screened against a superseded edition, which
is the behaviour you want.

Export the current DoD-published list to CSV with an `entity_name` column and a
`list_published_at` date, and drop it at `inbox/entity-list-1260h.csv`. Put its refresh on a
calendar like any other extract.

The Section 889 covered-manufacturer seed (`reference/covered-telecom.seed.csv`) ships with the five
manufacturers named in the statute itself. **That is a floor, not the whole answer** — subsidiaries
and affiliates are in scope too. Add yours.

---

## Step 4 — Wire your first real source

Four paths. Do **A** today; do the one that matches your stack this week.

### Path A — CSV exports (works everywhere, no credentials)

Get header-only templates:

```bash
npm run doctor -- --templates
```

That writes `inbox/*.template.csv` for every source. Fill in the ones you can, rename them to match
the paths in `ccp.config.yaml`, and re-run `npm run pipeline`.

This is not a consolation prize. A supplier master lives in an ERP nobody will give you a token for
this quarter, and the 1260H and 889 controls have no API to automate against anywhere. A documented
manual extract on a defined cadence is legitimate evidence. What is *not* legitimate is pretending
it is continuous — so `doctor` reports how old each file is and warns past 45 days.

### Path B — Entra ID (continuous, needs an app registration)

This is the one that turns MFA coverage into a live control.

**1. Register an application** in Entra ID. Note the tenant ID, client ID, and create a client
secret.

**2. Grant these APPLICATION permissions** (not delegated), then **grant admin consent** — the
consent step is the one people forget, and its absence looks like a mysterious 403:

| Permission | Why |
|---|---|
| `User.Read.All` | the identity population |
| `AuditLog.Read.All` | required for the authentication-methods report, unintuitively |
| `UserAuthenticationMethod.Read.All` | which factors are actually registered |

**3. Set the environment variables** (never put secrets in the config file):

```bash
export CCP_ENTRA_TENANT_ID=...
export CCP_ENTRA_CLIENT_ID=...
export CCP_ENTRA_CLIENT_SECRET=...
```

**4. If you are in GCC High or DoD, set `identity.cloud_environment: usgov`.** Government tenants
use `graph.microsoft.us` and `login.microsoftonline.us`. Getting this wrong produces a 401 that
looks exactly like a credentials problem and is not. This is the single most common failure for DIB
tenants.

**5.** `npm run doctor`, then `npm run pipeline`.

For **Azure** assets, the same app needs the **Reader** role on each enclave subscription, and you
must list those subscriptions in `cloud.subscriptions`. The tool deliberately does not query
"whatever the credential can see" — a boundary defined that way expands silently every time somebody
is granted access.

### Path C — Okta

Set `identity.provider: okta` and `identity.org_url`. **Government Okta cells are `okta-gov.com`
and `okta.mil`**, not `okta.com` — the same trap as `graph.microsoft.us`.

Create an API token (a **Read-Only Administrator** token is sufficient and is the least privilege
that works) and set `CCP_OKTA_ORG_URL` and `CCP_OKTA_API_TOKEN`.

Two things worth knowing before you run it. Okta has **no tenant-wide factor report**, so factors are
one call per user — genuinely N calls, bounded to 8 concurrent and retried on 429. That is the honest
cost of a complete population. And Okta names factors differently (`webauthn`, `u2f`,
`signed_nonce` rather than `fido2SecurityKey`); the default accepted set follows the provider, so
you only touch `identity.phishing_resistant_methods` if your policy differs.

**Only ACTIVE factors count.** An Okta enrolment can sit in `PENDING_ACTIVATION` indefinitely, and
counting it is how an MFA rollout reports full coverage while part of the population still signs in
with a password.

### Path D — AWS GovCloud

Set `cloud.provider: aws-govcloud` and `cloud.region` (`us-gov-west-1` or `us-gov-east-1`).
**The region is required and not defaulted**: GovCloud is a separate partition, and a commercial
region does not error — it queries the wrong partition and returns a confidently empty result, which
is exactly the shape of a silent false pass.

Install the optional SDK and use your normal AWS credential chain (profile, environment, or role):

```bash
npm install @aws-sdk/client-config-service
```

It reads **AWS Config**, not the Tagging API — the Tagging API only returns taggable resources, and
holes in the boundary inventory are holes in the denominator every other CUI-scoped control depends
on. Config needs to be enabled, which it needs to be for CMMC regardless.

For more than one account, set `cloud.aggregator` to a Config aggregator name. Without one, a single
query only ever sees the credential's own account — and if `cloud.accounts` declares more than it
found, the collector says so rather than letting a partial answer read as a whole one.

## Step 5 — Run it for real, on a schedule

```bash
npm run pipeline
```

Every run appends a snapshot to `.evidence/`. **That history is the point.** Variance Duration is
computed from how long each failure persists across snapshots, so a single run tells you what is
broken and a quarter of runs tells you how well you actually operate. Run it at least weekly — daily
for the identity and asset controls.

`.evidence/` is gitignored here because this is a public repository. **In yours, commit it** — it is
the audit trail, and a Git history of assertion records is a far better answer to an assessor than a
folder of screenshots.

---

## What you will need to customise

Ordered by how soon it will bite you.

| Area | Where | Notes |
|---|---|---|
| CUI boundary | `ccp.config.yaml` → `boundary` | Decision, not a setting |
| Sources | `ccp.config.yaml` → `identity`, `cloud`, `procurement`, `inventory`, `incident_response` | Start CSV, upgrade to API |
| Government endpoints | `identity.cloud_environment`, `identity.org_url`, `cloud.region` | GCC High, okta-gov.com and GovCloud all use different hosts or partitions |
| 1260H list | `inbox/entity-list-1260h.csv` | Refresh on a schedule |
| §889 manufacturers | `reference/covered-telecom.seed.csv` | Statutory five plus your affiliates |
| Phishing-resistant methods | `identity.phishing_resistant_methods` | Policy decision. Default excludes SMS and push |
| Break-glass accounts | `identity.break_glass_attribute` | An attribute, never a name pattern |
| Control population wording | `controls/*.yaml` → `population_definition` | Must match the model's `where` clause; `npm run validate` enforces it |
| Exceptions | `exceptions/*.yaml` | Expiry mandatory; an expired exception fails the build |
| SPRS weights | `reference/sprs-weights.yaml` | **Ships unpopulated.** The scorer refuses until you fill it from the DoD Assessment Methodology |
| Non-POA&M-able list | `reference/nist-800-171r2.index.yaml` | Verify against live 32 CFR Part 170 |
| The other 104 controls | `controls/` | `npm run coverage` prints the backlog |

## Adding a collector

The contract is small. Create `src/collectors/<name>.mjs` exporting:

```js
export const TABLE = 'src_something';           // a landing table from src/collectors/tables.mjs
export const CONTROLS = ['ctl.domain.layer.x']; // what it feeds
export function grade(data) { /* pure, testable without credentials */ }
export async function collect({ config, collectedAt, fixture }) {
  return { table: TABLE, rows: [...], population: { complete: true, source_of_truth: '...' } };
}
```

Then add one line to `src/collectors/registry.mjs`.

Three rules, learned the hard way and enforced throughout:

1. **Keep grading pure and separate from fetching.** It is what makes a collector testable without a
   tenant.
2. **An error is not an empty population.** Return `complete: false` with a reason, and every control
   over that table is withheld rather than passing.
3. **A permission error is not an absent configuration.** 401, 403-needs-consent, and 429 are three
   different facts. Never collapse them.

## Moving to a real warehouse

The models in `models/` are genuine dbt models — the same `{{ ref() }}`, `{{ source() }}`,
`{{ var() }}`. The bundled runner executes them against DuckDB so you need no Python on day one.

When you outgrow that: add a dbt profile, point `source()` at your landed tables, and run `dbt build`
instead of `npm run pipeline`. Expect a dialect pass — the SQL leans Postgres/DuckDB
(`extract(epoch from …)`, `array_length`). It is a migration, not a rewrite.

## What this does not do

Stated plainly so you find out here rather than in an assessment:

- **It does not cover all 110 requirements.** Six controls ship. `npm run coverage` prints the rest.
- **It does not model the 320 assessment objectives** from 800-171A. A C3PAO assesses objectives.
- **It has no evidence integrity layer** — no signing, no hashing, no retention enforcement.
- **It does not model inherited controls** from a cloud service provider, or the shared
  responsibility that comes with them.
- **It does not perform the SPRS affirmation.** That is a personal attestation by a named official.
- **It will not compute an SPRS score** until you populate the weight table yourself.
- **It does not route findings to owners.** The remediation queue is computed and never delivered.

None of those are hidden behind a flag. Where the tool cannot support a claim, it refuses to make
one — see `docs/watch-items.md` for the running list.
