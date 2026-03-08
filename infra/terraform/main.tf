terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  # Use GCS backend for team collaboration; comment out for local state
  # backend "gcs" {
  #   bucket = "meetmehalfway-tfstate"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Service Account ──────────────────────────────────────────────────────────

resource "google_service_account" "api" {
  account_id   = "meetmehalfway-api"
  display_name = "Meet Me Halfway API"
}

resource "google_project_iam_member" "api_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# ── Cloud SQL (PostgreSQL 15 + PostGIS) ──────────────────────────────────────

resource "google_sql_database_instance" "main" {
  name             = "meetmehalfway-db"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = "db-f1-micro"
    availability_type = "ZONAL"

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    backup_configuration {
      enabled = true
    }
  }

  deletion_protection = true
}

resource "google_sql_database" "app" {
  name     = "meetmehalfway"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "meetmehalfway"
  instance = google_sql_database_instance.main.name
  password = var.db_password
}

# ── Secret Manager ───────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "whatsapp_token" {
  secret_id = "WHATSAPP_TOKEN"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "google_places_key" {
  secret_id = "GOOGLE_PLACES_KEY"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "firebase_credentials" {
  secret_id = "FIREBASE_CREDENTIALS_JSON"
  replication {
    auto {}
  }
}

# ── Cloud Run ────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "api" {
  name     = "meet-me-halfway-api"
  location = var.region

  template {
    scaling {
      min_instance_count = 2
      max_instance_count = 10
    }

    containers {
      image = "gcr.io/${var.project_id}/meet-me-halfway-api:${var.image_tag}"

      ports {
        container_port = 8000
      }

      resources {
        limits = {
          memory = "512Mi"
          cpu    = "1"
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "WHATSAPP_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.whatsapp_token.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_PLACES_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_places_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "FIREBASE_CREDENTIALS_JSON"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.firebase_credentials.secret_id
            version = "latest"
          }
        }
      }
    }

    service_account = google_service_account.api.email

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
  }
}

# Allow unauthenticated access (public API)
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
