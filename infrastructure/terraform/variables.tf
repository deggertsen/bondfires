variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-2"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
  
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod"
  }
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "bondfires"
}

variable "store_credentials_in_secrets_manager" {
  description = "Whether to store the IAM credentials in AWS Secrets Manager"
  type        = bool
  default     = false
}

