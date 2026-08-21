output "role_arn" {
  description = "Set this as the AWS_COLLECTOR_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.collector.arn
}

output "evidence_bucket" {
  description = "Set this as CCP_EVIDENCE_BUCKET. Holds the accumulated snapshots that Variance Duration is computed from."
  value       = aws_s3_bucket.evidence.id
}

output "evidence_uri" {
  description = "Where the workflow syncs evidence to and from."
  value       = "s3://${aws_s3_bucket.evidence.id}/${var.evidence_prefix}"
}

output "trusted_subjects" {
  description = "Exactly which workflow subjects may assume the role. Anything else is refused."
  value       = [for ref in var.allowed_refs : "repo:${var.github_repository}:ref:${ref}"]
}
