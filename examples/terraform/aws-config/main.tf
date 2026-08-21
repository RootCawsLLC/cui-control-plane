# AWS Config, as infrastructure rather than as something somebody once clicked.
#
# WHY THIS IS IN A TOOL REPOSITORY. `ctl.cui.boundary.asset-inventory` is the denominator for every
# other CUI-scoped control, and its cloud half is AWS Config. If Config is not recording, the
# control cannot be evaluated - and worse, Config does not error when its recorder is gone. It keeps
# answering from the residual index, so a query returns a confident, well-formed, stale inventory.
# That happened: 82 resources reported as current at the top confidence tier, from an index whose
# recorder had been deleted, naming three S3 buckets that no longer existed.
#
# src/collectors/aws-assets.mjs now refuses that source. This is the other half - making the source
# reproducibly alive instead of relying on someone remembering to switch it back on.
#
# NOT A LANDING ZONE. It sets up recording, delivery and retention, and nothing else. No Config
# rules, no conformance packs, no aggregator - those are opinions about what to assess, and this
# module only exists to guarantee there is something to assess against.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Deriving the bucket name rather than taking it as input keeps the module honest about the one
  # thing that must be globally unique, and matches the existing lab convention.
  bucket_name = coalesce(var.delivery_bucket_name, "${var.name_prefix}-awsconfig-${local.account_id}")
}

# ---------------------------------------------------------------------------------------------
# Delivery bucket
# ---------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "config" {
  bucket = local.bucket_name

  tags = var.tags
}

# Public access is blocked as its own resource so it exists independently of the bucket policy.
# Ordering matters: a bucket that is briefly public before a policy lands is briefly public.
resource "aws_s3_bucket_public_access_block" "config" {
  bucket = aws_s3_bucket.config.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "config" {
  bucket = aws_s3_bucket.config.id

  versioning_configuration {
    status = var.versioning_enabled ? "Enabled" : "Suspended"
  }
}

# Config snapshots accumulate indefinitely otherwise. Expiry is a cost control, and it is separate
# from evidence retention - the assertion records in .evidence are the audit trail, not these.
resource "aws_s3_bucket_lifecycle_configuration" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    id     = "expire-config-history"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.config]
}

data "aws_iam_policy_document" "config_bucket" {
  # Config checks the bucket ACL before it will deliver anything at all.
  statement {
    sid    = "AWSConfigBucketPermissionsCheck"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = [aws_s3_bucket.config.arn]

    # Without SourceAccount the policy authorises the Config service in ANY account to probe this
    # bucket - the confused deputy shape.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid    = "AWSConfigBucketDelivery"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.config.arn}/AWSLogs/${local.account_id}/Config/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    # type "*" renders as `"Principal": "*"`, NOT `{"AWS": "*"}`, and in a Deny the difference is
    # substantive: `{"AWS":"*"}` reaches AWS principals, while bare `"*"` also reaches anonymous
    # unsigned requests. Writing this as type = "AWS" silently narrows a TLS-only deny, which was
    # caught by diffing the applied policy against the hand-written one it replaced.
    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.config.arn,
      "${aws_s3_bucket.config.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "config" {
  bucket = aws_s3_bucket.config.id
  policy = data.aws_iam_policy_document.config_bucket.json

  # The public access block must be in place first, or there is a window in which a policy could
  # be evaluated against an unprotected bucket.
  depends_on = [aws_s3_bucket_public_access_block.config]
}

# ---------------------------------------------------------------------------------------------
# Recorder
# ---------------------------------------------------------------------------------------------

# The service-linked role, not a hand-rolled one. AWS maintains its permissions, which is one fewer
# policy to drift. It usually already exists in an account that has ever run Config, hence the
# create toggle rather than an unconditional resource.
resource "aws_iam_service_linked_role" "config" {
  count            = var.create_service_linked_role ? 1 : 0
  aws_service_name = "config.amazonaws.com"
}

locals {
  config_role_arn = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig"
}

resource "aws_config_configuration_recorder" "this" {
  name     = var.recorder_name
  role_arn = local.config_role_arn

  recording_group {
    # all_supported, not an allow-list. An allow-list is a decision about what counts as an asset,
    # and every type left off is a hole in the denominator of the boundary inventory - invisible,
    # because a resource that is never recorded cannot appear as a finding.
    all_supported                 = true
    include_global_resource_types = var.include_global_resource_types
  }

  depends_on = [aws_iam_service_linked_role.config]
}

resource "aws_config_delivery_channel" "this" {
  name           = var.delivery_channel_name
  s3_bucket_name = aws_s3_bucket.config.id

  dynamic "snapshot_delivery_properties" {
    for_each = var.snapshot_delivery_frequency == null ? [] : [var.snapshot_delivery_frequency]
    content {
      delivery_frequency = snapshot_delivery_properties.value
    }
  }

  # A delivery channel cannot be created before the recorder exists, and cannot deliver before the
  # bucket policy allows it.
  depends_on = [
    aws_config_configuration_recorder.this,
    aws_s3_bucket_policy.config,
  ]
}

# Separate from the recorder on purpose: this is the resource that answers "is it actually running",
# and it is the one whose absence produced the stale-index incident.
resource "aws_config_configuration_recorder_status" "this" {
  name       = aws_config_configuration_recorder.this.name
  is_enabled = var.recording_enabled

  depends_on = [aws_config_delivery_channel.this]
}
