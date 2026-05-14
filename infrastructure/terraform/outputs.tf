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
