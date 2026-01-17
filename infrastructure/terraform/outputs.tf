# ============================================================
# S3 Bucket Outputs
# ============================================================

output "s3_bucket_name" {
  description = "Name of the S3 bucket for video storage"
  value       = aws_s3_bucket.videos.id
}

output "s3_bucket_arn" {
  description = "ARN of the S3 bucket for video storage"
  value       = aws_s3_bucket.videos.arn
}

output "s3_bucket_region" {
  description = "Region of the S3 bucket"
  value       = var.aws_region
}

# ============================================================
# IAM Credentials (for Convex environment variables)
# ============================================================

output "convex_aws_access_key_id" {
  description = "AWS Access Key ID for Convex actions"
  value       = aws_iam_access_key.convex_s3.id
  sensitive   = true
}

output "convex_aws_secret_access_key" {
  description = "AWS Secret Access Key for Convex actions"
  value       = aws_iam_access_key.convex_s3.secret
  sensitive   = true
}

# ============================================================
# Convex Environment Variables (copy these to Convex dashboard)
# ============================================================

output "convex_environment_variables" {
  description = "Environment variables to set in Convex dashboard"
  value = {
    AWS_ACCESS_KEY_ID     = aws_iam_access_key.convex_s3.id
    AWS_SECRET_ACCESS_KEY = aws_iam_access_key.convex_s3.secret
    AWS_REGION            = var.aws_region
    S3_BUCKET_NAME        = aws_s3_bucket.videos.id
  }
  sensitive = true
}

output "convex_setup_instructions" {
  description = "Instructions for setting up Convex with AWS"
  value       = <<-EOT
    
    ==========================================
    CONVEX ENVIRONMENT VARIABLES SETUP
    ==========================================
    
    Run the following command to get the credentials:
    
      terraform output -json convex_environment_variables
    
    Then add these to your Convex dashboard:
    1. Go to https://dashboard.convex.dev
    2. Select your project
    3. Go to Settings > Environment Variables
    4. Add each variable from the output above
    
    S3 Bucket: ${aws_s3_bucket.videos.id}
    Region: ${var.aws_region}
    
  EOT
}

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
    
    To deploy the website (run from repository root):
    
    1. Sync files to S3 bucket:
    
       aws s3 sync apps/website/ s3://${aws_s3_bucket.website.id}/ \
         --delete \
         --exclude "README.md"
    
    2. Invalidate CloudFront cache:
    
       aws cloudfront create-invalidation \
         --distribution-id ${aws_cloudfront_distribution.website.id} \
         --paths "/*"
    
    3. Website will be available at:
    
       https://${aws_cloudfront_distribution.website.domain_name}
    
    Quick one-liner:
    
       aws s3 sync apps/website/ s3://${aws_s3_bucket.website.id}/ --delete --exclude "README.md" && \
       aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.website.id} --paths "/*"
    
    For custom domain, configure Route53 and update CloudFront with ACM certificate.
    See apps/website/README.md for detailed deployment documentation.
    
  EOT
}

