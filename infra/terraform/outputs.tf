output "api_url" {
  description = "Cloud Run API service URL"
  value       = google_cloud_run_v2_service.api.uri
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name for proxy"
  value       = google_sql_database_instance.main.connection_name
}
