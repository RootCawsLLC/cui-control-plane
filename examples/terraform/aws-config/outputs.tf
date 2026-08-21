output "delivery_bucket" {
  description = "Bucket receiving Config snapshots."
  value       = aws_s3_bucket.config.id
}

output "recorder_name" {
  description = "Configuration recorder name."
  value       = aws_config_configuration_recorder.this.name
}

output "recording" {
  description = "Whether the recorder is enabled. `ccp doctor` and the aws-assets collector both refuse the source when this is false."
  value       = aws_config_configuration_recorder_status.this.is_enabled
}

output "verify_command" {
  description = "The check the collector performs. Run it after apply rather than trusting apply's exit code."
  value       = "aws configservice describe-configuration-recorder-status --region <region> --query 'ConfigurationRecordersStatus[].{recording:recording,lastStatus:lastStatus}'"
}
