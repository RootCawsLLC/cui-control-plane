variable "name_prefix" {
  description = "Prefix for created resources. Only used to derive the delivery bucket name when one is not supplied."
  type        = string
  default     = "ccp"
}

variable "delivery_bucket_name" {
  description = "Existing or desired delivery bucket. Leave null to derive <name_prefix>-awsconfig-<account_id>, which is globally unique without a random suffix."
  type        = string
  default     = null
}

variable "recorder_name" {
  description = "Configuration recorder name. AWS permits exactly one per region, and 'default' is the conventional name."
  type        = string
  default     = "default"
}

variable "delivery_channel_name" {
  description = "Delivery channel name. Also one per region."
  type        = string
  default     = "default"
}

variable "recording_enabled" {
  description = "Whether the recorder is running. Setting this false is how you stop billing without destroying the history already delivered."
  type        = bool
  default     = true
}

variable "include_global_resource_types" {
  description = "Record global resources such as IAM. Enable in EXACTLY ONE region - enabling it in several records every IAM change several times and bills for each."
  type        = bool
  default     = true
}

variable "create_service_linked_role" {
  description = "Create the Config service-linked role. Leave false when the account already has one, which is usual - creating a duplicate fails."
  type        = bool
  default     = false
}

variable "snapshot_delivery_frequency" {
  description = "Periodic snapshot frequency, e.g. TwentyFour_Hours. Null leaves AWS's default. Continuous recording still happens either way; this only controls the periodic full snapshot."
  type        = string
  default     = null

  validation {
    condition = var.snapshot_delivery_frequency == null || contains(
      ["One_Hour", "Three_Hours", "Six_Hours", "Twelve_Hours", "TwentyFour_Hours"],
      coalesce(var.snapshot_delivery_frequency, "TwentyFour_Hours")
    )
    error_message = "Must be one of One_Hour, Three_Hours, Six_Hours, Twelve_Hours, TwentyFour_Hours."
  }
}

variable "retention_days" {
  description = "Days before delivered Config snapshots expire from the bucket. A cost control, NOT your evidence retention - the assertion records under .evidence are the audit trail."
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days >= 1
    error_message = "retention_days must be at least 1."
  }
}

variable "versioning_enabled" {
  description = "Versioning on the delivery bucket."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to created resources."
  type        = map(string)
  default     = {}
}
