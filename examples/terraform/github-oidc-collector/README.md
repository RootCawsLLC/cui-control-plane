# Unattended evidence collection via GitHub OIDC

Creates the role a scheduled GitHub Actions run assumes, and the bucket the evidence accumulates in.

## Why it is needed

Variance Duration is measured from how long a failure persists **across snapshots**. That requires
the pipeline to run on a schedule and the evidence to survive between runs — neither of which a
human-driven run provides, because AWS SSO sessions expire in about an hour and refreshing one needs
somebody to type a device code.

Worse, an unattended run under expired credentials does not fail loudly. The collector reports the
source unavailable, every control over it is withheld, and the job looks like it ran while producing
no snapshot at all. The workflow therefore **fails explicitly when nothing was asserted**.

## Usage

```hcl
module "collector" {
  source            = "github.com/RootCawsLLC/cui-control-plane//examples/terraform/github-oidc-collector"
  github_repository = "your-org/your-repo"
}
```

Then set the two outputs as repository **variables** (not secrets — a role ARN and a bucket name are
not credentials, and variables appear in logs, which helps when a run fails):

```bash
gh variable set AWS_COLLECTOR_ROLE_ARN --body "$(terraform output -raw role_arn)"
gh variable set CCP_EVIDENCE_BUCKET   --body "$(terraform output -raw evidence_bucket)"
```

## Security decisions

**The trust policy pins `sub` to specific refs, defaulting to `refs/heads/main`.** On a public
repository a wildcard (`repo:owner/name:*`) would let a workflow on *any* branch assume the role, and
anyone who can open a pull request can propose a workflow file. `allowed_refs` refuses wildcards
outright rather than trusting the operator to notice.

Fork pull requests cannot reach it regardless — GitHub does not mint an id-token for the base
repository on a fork PR — but relying on that alone means relying on a GitHub behaviour instead of on
your own trust policy.

**The `aud` condition is present.** Without it the role accepts a token minted for any audience.

**Permissions are enumerated, not `ReadOnlyAccess`.** This role runs unattended on a schedule against
an account holding real data; "read-only" still means "can read everything" if you let it.

**The role cannot delete.** There is no `s3:DeleteObject` anywhere. A collection job that can delete
history can destroy the variance record it exists to build, and nothing in the pipeline needs to.

**The evidence bucket is versioned.** Unlike the Config delivery bucket, versioning here is not
optional: this holds the audit trail, and an overwrite that loses a prior snapshot silently shortens
every variance duration computed from it.

## Seeding

Variance needs at least two snapshots on different days. If you have local evidence, seed it before
the first scheduled run, or the first run is still snapshot one:

```bash
aws s3 sync .evidence "s3://$(terraform output -raw evidence_bucket)/evidence"
```
