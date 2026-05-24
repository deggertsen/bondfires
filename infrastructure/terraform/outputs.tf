# ============================================================
# Website Outputs
# ============================================================

output "website_bucket_name" {
  description = "Name of the S3 bucket for website hosting"
  value       = aws_s3_bucket.website.id
}

output "website_bucket_arn" {
  description = "ARN of the S3 bucket for website hosting"
  value       = aws_s3_bucket.website.arn
}

output "website_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for the website"
  value       = aws_cloudfront_distribution.website.id
}

output "website_cloudfront_domain_name" {
  description = "CloudFront distribution domain name for the website"
  value       = aws_cloudfront_distribution.website.domain_name
}

output "website_url" {
  description = "URL of the website (CloudFront distribution)"
  value       = "https://${aws_cloudfront_distribution.website.domain_name}"
}

output "website_deployment_instructions" {
  description = "Instructions for deploying the website"
  value       = <<-EOT
    
    ==========================================
    WEBSITE DEPLOYMENT INSTRUCTIONS
    ==========================================
    
    Website source: https://github.com/deggertsen/bondfires-website
    
    This Terraform stack is legacy. The site is now deployed via Cloudflare Pages.
    
    To destroy this stack after bondfires.org is live on Pages:
    
       cd infrastructure/terraform
       terraform destroy -var-file=environments/prod/prod.tfvars
    
  EOT
}
