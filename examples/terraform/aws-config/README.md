# AWS Config, as infrastructure

Terraform that guarantees AWS Config is **recording**, which
`ctl.cui.boundary.asset-inventory` depends on absolutely.

## Why this ships with the tool

Config is the cloud half of the boundary inventory, and that inventory is the denominator for every
other CUI-scoped control. The problem is that **AWS Config does not error when its recorder is
gone** — `SelectResourceConfig` keeps answering from the residual index.

That is not hypothetical. In this project's own lab account, the collector read 82 resources and
reported them as current at the top confidence tier, from an index whose recorder had been deleted:
three of the five S3 buckets it named no longer existed, four buckets that did exist were invisible
to it, and the newest item was 17 days old. A confident, well-formed, wrong inventory.

`src/collectors/aws-assets.mjs` now refuses that source. This module is the other half — making the
source reproducibly alive rather than depending on somebody remembering to switch it back on.

## Usage

```hcl
module "aws_config" {
  source = "github.com/RootCawsLLC/cui-control-plane//examples/terraform/aws-config"

  name_prefix = "acme"
  tags        = { Project = "cui-enclave" }
}
```

Then confirm by status rather than by `apply` exiting 0:

```bash
aws configservice describe-configuration-recorder-status --region us-east-1 \
  --query 'ConfigurationRecordersStatus[].{recording:recording,lastStatus:lastStatus}'
```

`recording: true` with `lastStatus: SUCCESS` is what the collector requires. `PENDING` is normal for
the first minutes after enabling — the check only refuses on `FAILURE`.

## Adopting a recorder that already exists

Most accounts have one. Import rather than recreate, or you interrupt recording and lose continuity:

```bash
terraform import aws_s3_bucket.config                                   <bucket>
terraform import aws_s3_bucket_public_access_block.config               <bucket>
terraform import aws_s3_bucket_server_side_encryption_configuration.config <bucket>
terraform import aws_s3_bucket_policy.config                            <bucket>
terraform import aws_config_configuration_recorder.this                 default
terraform import aws_config_delivery_channel.this                       default
terraform import aws_config_configuration_recorder_status.this          default
```

Then `terraform plan` and **read the summary before applying**. `0 to destroy` is the property that
matters; a plan proposing to replace the recorder will interrupt recording.

## Choices worth understanding

**`all_supported = true`, not an allow-list.** An allow-list is a decision about what counts as an
asset, and every type left off is an invisible hole in the boundary denominator — a resource that is
never recorded cannot appear as a finding.

**`include_global_resource_types` in exactly one region.** Enabling it everywhere records every IAM
change once per region and bills for each.

**The service-linked role**, not a hand-rolled one — AWS maintains its permissions, so there is one
fewer policy to drift. `create_service_linked_role` defaults to `false` because most accounts
already have it and creating a duplicate fails.

**`retention_days` is a cost control, not evidence retention.** It expires delivered Config
snapshots. Your audit trail is the assertion records under `.evidence`.

## A subtlety in the bucket policy

The TLS-only deny uses `principals { type = "*" }`, which renders as `"Principal": "*"`. Writing the
more natural `type = "AWS"` renders `{"AWS": "*"}` — and in a **Deny** those are not equivalent:
`{"AWS":"*"}` reaches AWS principals, while bare `"*"` also reaches anonymous unsigned requests.

This was caught by diffing the Terraform-applied policy against the hand-written one it replaced,
and it is the kind of narrowing that no plan output would have flagged, because the policy document
is `(known after apply)`.

## Cost

Config bills per configuration item recorded, plus S3 storage. To stop recording without destroying
delivered history, set `recording_enabled = false` and apply — the collector will then correctly
refuse the source rather than reading a frozen index.
