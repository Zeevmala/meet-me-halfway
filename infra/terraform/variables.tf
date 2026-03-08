variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "me-west1"
}

variable "db_password" {
  description = "Cloud SQL database password"
  type        = string
  sensitive   = true
}

variable "image_tag" {
  description = "Docker image tag for Cloud Run deployment"
  type        = string
  default     = "latest"
}
