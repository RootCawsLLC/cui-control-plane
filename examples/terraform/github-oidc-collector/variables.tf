variable "github_repository" {
  description = "owner/name of the repository allowed to assume this role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Must be owner/name, e.g. RootCawsLLC/cui-control-plane."
  }
}

variable "allowed_refs" {
  description = "Git refs whose workflows may assume the role. Defaults to main only. Widening this to a wildcard on a PUBLIC repository lets anyone who can open a pull request propose a workflow that assumes it."
  type        = list(string)
  default     = ["refs/heads/main"]

  validation {
    condition     = alltrue([for r in var.allowed_refs : !strcontains(r, "*")])
    error_message = "Wildcards are refused. Name each ref explicitly - a wildcard sub is how an OIDC role gets assumed from an untrusted branch."
  }
}

variable "role_name" {
  description = "Name of the collector role."
  type        = string
  default     = "ccp-evidence-collector"
}

variable "name_prefix" {
  description = "Prefix used to derive the evidence bucket name when one is not supplied."
  type        = string
  default     = "ccp"
}

variable "evidence_bucket_name" {
  description = "Existing or desired evidence bucket. Null derives <name_prefix>-ccp-evidence-<account_id>."
  type        = string
  default     = null
}

variable "evidence_prefix" {
  description = "Key prefix the role may read and write. The role has no access outside it."
  type        = string
  default     = "evidence"
}

variable "max_session_duration" {
  description = "Seconds. One hour is ample for a collection run and limits the blast radius of a leaked token."
  type        = number
  default     = 3600

  validation {
    condition     = var.max_session_duration >= 900 && var.max_session_duration <= 43200
    error_message = "AWS permits 900 to 43200 seconds."
  }
}

variable "tags" {
  description = "Tags applied to created resources."
  type        = map(string)
  default     = {}
}
