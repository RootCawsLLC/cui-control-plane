# A GitHub Actions role for unattended evidence collection, plus somewhere for the evidence to live.
#
# WHY THIS EXISTS. Variance Duration is computed from how long a failure persists ACROSS snapshots,
# so the pipeline has to run on a schedule and the evidence has to accumulate. Neither is possible
# under a human-approved login: AWS SSO sessions expire in about an hour and refreshing one requires
# somebody to enter a device code. An unattended run under expired credentials does not fail loudly
# either - the collector reports the source unavailable, every control over it is withheld, and the
# job looks like it ran while producing no snapshot at all.
#
# GitHub's OIDC provider solves it without a long-lived key existing anywhere.

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
  oidc_arn   = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
  bucket     = coalesce(var.evidence_bucket_name, "${var.name_prefix}-ccp-evidence-${local.account_id}")
}

# The provider is account-wide and almost always already present - creating a second one fails, and
# it is shared infrastructure that this module has no business owning. Referenced, never created.
data "aws_iam_openid_connect_provider" "github" {
  arn = local.oidc_arn
}

# ---------------------------------------------------------------------------------------------
# Trust
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    # Without the aud condition the role would accept a token minted for ANY audience. GitHub sets
    # sts.amazonaws.com when the workflow requests AWS credentials; anything else is not our caller.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # THE IMPORTANT ONE. `sub` is scoped to a specific ref, not `repo:owner/name:*`.
    #
    # This repository is PUBLIC. A wildcard sub would let a workflow on ANY branch assume this role,
    # and anyone who can open a pull request can propose a workflow file. Pinning to refs/heads/main
    # means only code that has already been merged can collect. The scheduled run is the only caller
    # that needs it.
    #
    # Fork pull requests cannot reach this regardless - GitHub does not mint an id-token for the base
    # repository on a fork PR - but relying on that alone would be relying on a GitHub behaviour
    # rather than on our own trust policy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for ref in var.allowed_refs : "repo:${var.github_repository}:ref:${ref}"]
    }
  }
}

resource "aws_iam_role" "collector" {
  name                 = var.role_name
  description          = "Read-only evidence collection for cui-control-plane, assumed by GitHub Actions via OIDC"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = var.max_session_duration

  tags = var.tags
}

# ---------------------------------------------------------------------------------------------
# Permissions - read-only, plus write to this one evidence prefix
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "collect" {
  # Everything the collectors read. Deliberately enumerated rather than a ReadOnlyAccess managed
  # policy: this role runs unattended on a schedule against an account holding real data, and
  # "read-only" still means "can read everything" if you let it.
  statement {
    sid    = "ConfigInventory"
    effect = "Allow"
    actions = [
      "config:SelectResourceConfig",
      "config:SelectAggregateResourceConfig",
      # The liveness check. Without it the collector cannot tell a live recorder from a deleted one
      # answering out of its residual index, which is the failure that made this repository refuse
      # the source in the first place.
      "config:DescribeConfigurationRecorders",
      "config:DescribeConfigurationRecorderStatus",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "WorkforceInventory"
    effect = "Allow"
    actions = [
      "sso:ListInstances",
      "sso:DescribeInstance",
      "identitystore:ListUsers",
      "identitystore:ListGroups",
      "identitystore:ListGroupMemberships",
    ]
    resources = ["*"]
  }

  # The credential report is account-wide and cannot be resource-scoped. It reveals which principals
  # hold MFA and keys - sensitive, hence the tight trust policy above rather than a looser role.
  statement {
    sid    = "IamCredentialReport"
    effect = "Allow"
    actions = [
      "iam:GenerateCredentialReport",
      "iam:GetCredentialReport",
      "iam:ListUsers",
    ]
    resources = ["*"]
  }

  # Evidence accumulates here across runs. This is the ONLY write the role has, and it is confined
  # to one prefix in one bucket.
  statement {
    sid       = "EvidenceRead"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.evidence.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.evidence_prefix}/*", var.evidence_prefix]
    }
  }

  statement {
    sid       = "EvidenceWrite"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/${var.evidence_prefix}/*"]
  }

  # No s3:DeleteObject anywhere. Evidence is append-only: a collection job that can delete history
  # can destroy the variance record it exists to build, and nothing in the pipeline ever needs to.
}

resource "aws_iam_role_policy" "collect" {
  name   = "${var.role_name}-collect"
  role   = aws_iam_role.collector.id
  policy = data.aws_iam_policy_document.collect.json
}

# ---------------------------------------------------------------------------------------------
# Evidence store
# ---------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "evidence" {
  bucket = local.bucket
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Versioning is not optional here the way it is on the Config delivery bucket. This holds the audit
# trail, and an overwrite that loses a prior snapshot silently shortens every variance duration
# computed from it.
resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "evidence_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    # type "*" renders as `"Principal": "*"`, which in a Deny also reaches anonymous unsigned
    # requests. `{"AWS": "*"}` would not - see examples/terraform/aws-config for the full note.
    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket     = aws_s3_bucket.evidence.id
  policy     = data.aws_iam_policy_document.evidence_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.evidence]
}
