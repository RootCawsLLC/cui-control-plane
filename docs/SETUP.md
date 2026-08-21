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

Five paths. Do **A** today; do the one that matches your stack this week.

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

### The asset inventory needs two sources, not one

The boundary asset control is a **reconciliation**, and it is the denominator every other
CUI-scoped control is a subset of. It compares what your CMDB *claims* is in the boundary against
what the cloud *actually reports*, because the two answers disagree and the disagreement is the
finding:

- in the cloud, absent from the CMDB → an **unmanaged asset**, which is what the control fails on;
- in the CMDB, absent from the cloud → a **stale record**, which is a data-quality problem.

With only one side wired the control cannot tell those apart, and it does not fail loudly — it
reports its own missing source as though it were a fact about your estate. A cloud-only estate
returns *every* asset as absent from the CMDB; a CMDB-only estate returns every asset as managed
and the unmanaged-asset finding can never fire. Both look like measurements. Neither is one.

So the CMDB is its own setting, independent of `cloud.provider`:

```yaml
cmdb:
  source: csv
  assets_path: "inbox/cmdb-assets.csv"

mdm:
  source: csv
  devices_path: "inbox/mdm-devices.csv"
```

Required column for the CMDB export is `asset_id`; `asset_type`, `owner`, `classification` and
`in_cui_boundary` are what the control actually grades on, so an export without `owner` and
`classification` will fail every asset for want of them. The MDM export needs `device_id`, plus
`assigned_user`, `enclave_enrolled` and `agent_last_seen`.

Endpoints are the third leg and are worth wiring even if they feel obvious: laptops appear in
neither the CMDB nor the cloud API, and they are where CUI documents actually get opened.

`npm run doctor` warns when either half is missing, and `npm run pipeline` flags any control whose
whole population fails for one single reason — the signature of a missing source rather than an
estate in uniform breach.

Both halves being present is not the same as both halves being *about the same estate*. The pipeline
also compares the two sets of identifiers and says so when they share almost nothing:

> csv-cloud-resources and csv-cmdb-assets are supposed to be independent views of the same estate,
> but share 1 of 68 identifiers.

That is worth reading carefully, because it does not look like a configuration problem — it looks
like a catastrophic estate. The run that prompted this check reported 81 unmanaged assets and 68
unclassified ones against a real account. Both exports were well formed, both used identical
identifier formats, and normalising the join key recovered nothing: the cloud query was answering
from a decommissioned index while the CMDB described resources that genuinely existed. When you see
this note, check the export, the account and the region before you open a single ticket.

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

### Path E — AWS IAM users (single account, no federation)

Set `identity.provider: aws-iam`. Uses the standard AWS credential chain — no extra secrets.

**Read this before choosing it.** Entra and Okta are identity providers; AWS IAM is an
authorisation system for one account that happens to hold user records. If your people sign in
through an IdP and assume roles, your IAM users are service principals and break-glass accounts —
a population of two or three, not your workforce — and pointing the MFA control at them produces a
flattering number about the wrong set.

It is the right choice for the case that is common among smaller subcontractors: one AWS account,
IAM users as the actual human sign-in path, no federation. The tool cannot tell which case you are
in, so choosing this provider is you asserting the second one.

Two behaviours worth knowing:

- **Principals with no console password are excluded by default.** A key-only automation user has
  no console to phish, so counting it as an unenrolled human overstates the failure. Set
  `identity.include_console_disabled: true` if you genuinely sign in with those.
- **IAM MFA never reports as phishing-resistant.** The credential report cannot distinguish TOTP
  from a hardware key, so the control fails an enrolled TOTP user with
  `no_phishing_resistant_factor` — correctly, for a CUI boundary. That is a real finding about
  your authentication strength, not a gap in the collector.

Permissions: `iam:ListUsers`, `iam:GenerateCredentialReport`, `iam:GetCredentialReport`.

### Path D — AWS GovCloud

Set `cloud.provider: aws-govcloud` and `cloud.region` (`us-gov-west-1` or `us-gov-east-1`).
**The region is required and not defaulted**: GovCloud is a separate partition, and a commercial
region does not error — it queries the wrong partition and returns a confidently empty result, which
is exactly the shape of a silent false pass.

Install the optional SDK and use your normal AWS credential chain (profile, environment, or role):

```bash
npm install @aws-sdk/client-config-service
```

Set `cloud.owner_tag` and `cloud.classification_tag` to whatever your estate actually uses. This
was found the hard way: pointed at a real account that tags everything with `Project`,
`Environment`, `ManagedBy` and `ComplianceScope`, the collector reported 82 of 82 resources
unowned. That is one configuration line, not 82 findings, and the pipeline now says so on the run.

Config must actually be **recording**. The collector checks `DescribeConfigurationRecorderStatus`
before querying and refuses if no recorder exists, if it is stopped, or if every recorder reports
`FAILURE` — because `SelectResourceConfig` keeps answering from the residual index after a recorder
is deleted, returning a confident, well-formed, wrong inventory. It also refuses when the newest
item is older than `cloud.max_staleness_days`, which catches a recorder that is running and
capturing nothing.

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
| Sources | `ccp.config.yaml` → `identity`, `cloud`, `cmdb`, `mdm`, `procurement`, `inventory`, `incident_response` | Start CSV, upgrade to API |
| **Asset reconciliation** | `cloud` **and** `cmdb` (and `mdm`) | Both halves, or the control restates one source instead of reconciling two. One half alone is not a measurement |
| Government endpoints | `identity.cloud_environment`, `identity.org_url`, `cloud.region` | GCC High, okta-gov.com and GovCloud all use different hosts or partitions |
| **Config freshness** | `cloud.max_staleness_days` | Default 7. AWS Config answers from its index even when the recorder is deleted, so the collector checks the recorder is running and the newest item is recent, and **withholds** rather than reporting a stale snapshot as current |
| **Asset tag keys** | `cloud.owner_tag`, `cloud.classification_tag` | Defaults are `owner` / `data_classification`. **Check these first** if the inventory reports everything unowned - it is usually the wrong tag key, not universal non-compliance |
| 1260H list | `inbox/entity-list-1260h.csv` | Refresh on a schedule |
| §889 manufacturers | `reference/covered-telecom.seed.csv` | Statutory five plus your affiliates |
| Phishing-resistant methods | `identity.phishing_resistant_methods` | Policy decision. Default excludes SMS and push |
| Break-glass accounts | `identity.break_glass_attribute` | An attribute, never a name pattern |
| Control population wording | `controls/*.yaml` → `population_definition` | Must match the model's `where` clause; `npm run validate` enforces it |
| Exceptions | `exceptions/*.yaml` | Expiry mandatory; an expired exception fails the build |
| SPRS weights | `reference/sprs-weights.yaml` | **Ships unpopulated.** The scorer refuses until you fill it from the DoD Assessment Methodology |
| Non-POA&M-able list | `reference/nist-800-171r2.index.yaml` | Verify against live 32 CFR Part 170 |
| The other 104 controls | `controls/` | `npm run coverage` prints the backlog |

## Working on this repository

`npm run setup` arms `.githooks/pre-commit`, which enforces two things.

The first is commit identity: the owning account rejects pushes that expose its private address,
so a wrong-identity commit has to be rewritten rather than fixed forward.

The second is that **the primary checkout is not a working tree**. Commits there are refused, and
work belongs in a linked worktree — one per session, so two sessions cannot share an index:

```bash
node ~/.claude/scripts/worktree.mjs add cui-control-plane <branch>   # --with-lab for real config
```

Staged changes survive a refusal; nothing is lost. `ALLOW_PRIMARY_COMMIT=1 git commit` is the
deliberate exception, and exists so the hook gets used rather than deleted.

This is a hook rather than a note because the failure it prevents is invisible to git. Two
sessions shared this checkout on 2026-08-20: a file was rewritten mid-edit under one of them,
`.evidence/` was emptied between two commands, and a `git add -A` staged another session's
unfinished work. None of that is a conflict, so nothing warned anybody.

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
- **It has no evidence integrity layer** — no signing, no hashing. Retention is *measured*
  against `evidence.retain_days` and reported by `ccp doctor`, but never enforced: nothing here
  deletes evidence, and a shortfall is a warning rather than an action.
- **It does not model inherited controls** from a cloud service provider, or the shared
  responsibility that comes with them.
- **It does not perform the SPRS affirmation.** That is a personal attestation by a named official.
- **It will not compute an SPRS score** until you populate the weight table yourself.
- **It does not route findings to owners.** The remediation queue is computed and never delivered.

None of those are hidden behind a flag. Where the tool cannot support a claim, it refuses to make
one — see `docs/watch-items.md` for the running list.
