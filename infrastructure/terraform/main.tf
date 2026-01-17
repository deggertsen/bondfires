terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Backend configuration - can be customized per environment
  # For now, using local state. In production, use S3 backend.
  # backend "s3" {
  #   bucket         = "bondfires-terraform-state"
  #   key            = "bondfires/terraform.tfstate"
  #   region         = "us-east-2"
  #   encrypt        = true
  #   dynamodb_table = "bondfires-terraform-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "bondfires"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# ============================================================
# S3 Bucket for Video Storage
# ============================================================

resource "aws_s3_bucket" "videos" {
  bucket = "${var.project_name}-${var.environment}-videos"

  tags = {
    Name        = "${var.project_name}-${var.environment}-videos"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "videos" {
  bucket = aws_s3_bucket.videos.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "videos" {
  bucket = aws_s3_bucket.videos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["*"] # Restrict in production to your app domains
    expose_headers  = ["ETag", "Content-Length", "Content-Type"]
    max_age_seconds = 3600
  }
}

# Lifecycle rules for cost optimization
resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    # Move videos to Infrequent Access after 30 days
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    # Move to Glacier after 90 days (optional, for very old content)
    # transition {
    #   days          = 90
    #   storage_class = "GLACIER"
    # }

    # Delete incomplete multipart uploads after 7 days
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "delete-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ============================================================
# IAM User for Convex Actions (S3 Access)
# ============================================================

resource "aws_iam_user" "convex_s3" {
  name = "${var.project_name}-${var.environment}-convex-s3"
  path = "/service-accounts/"

  tags = {
    Name        = "${var.project_name}-${var.environment}-convex-s3"
    Environment = var.environment
    Purpose     = "Convex actions S3 access"
  }
}

resource "aws_iam_access_key" "convex_s3" {
  user = aws_iam_user.convex_s3.name
}

# IAM Policy for S3 access
resource "aws_iam_user_policy" "convex_s3" {
  name = "${var.project_name}-${var.environment}-convex-s3-policy"
  user = aws_iam_user.convex_s3.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BucketAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetObjectAttributes"
        ]
        Resource = [
          aws_s3_bucket.videos.arn,
          "${aws_s3_bucket.videos.arn}/*"
        ]
      },
      {
        Sid    = "S3PresignedUrls"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.videos.arn}/*"
        ]
      }
    ]
  })
}

# ============================================================
# Secrets Storage (for reference - credentials output below)
# ============================================================

# Store the access key in AWS Secrets Manager (optional)
resource "aws_secretsmanager_secret" "convex_s3_credentials" {
  count = var.store_credentials_in_secrets_manager ? 1 : 0
  
  name        = "${var.project_name}/${var.environment}/convex-s3-credentials"
  description = "AWS credentials for Convex S3 access"

  tags = {
    Name        = "${var.project_name}-${var.environment}-convex-s3-credentials"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "convex_s3_credentials" {
  count = var.store_credentials_in_secrets_manager ? 1 : 0
  
  secret_id = aws_secretsmanager_secret.convex_s3_credentials[0].id
  secret_string = jsonencode({
    AWS_ACCESS_KEY_ID     = aws_iam_access_key.convex_s3.id
    AWS_SECRET_ACCESS_KEY = aws_iam_access_key.convex_s3.secret
    AWS_REGION            = var.aws_region
    S3_BUCKET_NAME        = aws_s3_bucket.videos.id
  })
}

# ============================================================
# S3 Bucket for Website Hosting
# ============================================================

resource "aws_s3_bucket" "website" {
  bucket = "${var.project_name}-${var.environment}-website"

  tags = {
    Name        = "${var.project_name}-${var.environment}-website"
    Environment = var.environment
    Purpose     = "Static website hosting"
  }
}

resource "aws_s3_bucket_versioning" "website" {
  bucket = aws_s3_bucket.website.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket = aws_s3_bucket.website.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Note: We don't configure static website hosting directly on S3
# Instead, CloudFront accesses the bucket via Origin Access Control (OAC)
# This is more secure than public read access

# ============================================================
# CloudFront Distribution for Website CDN/HTTPS
# ============================================================

# CloudFront Origin Access Control (replaces OAI, recommended approach)
resource "aws_cloudfront_origin_access_control" "website" {
  name                              = "${var.project_name}-${var.environment}-website-oac"
  description                       = "Origin Access Control for website S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "website" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "${var.project_name}-${var.environment}-website distribution"

  # S3 origin with OAC (Origin Access Control)
  origin {
    domain_name                = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                  = "S3-${aws_s3_bucket.website.id}"
    origin_access_control_id   = aws_cloudfront_origin_access_control.website.id
  }

  # Default cache behavior
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-${aws_s3_bucket.website.id}"
    compress               = true
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # Cache behavior for HTML files (shorter TTL)
  ordered_cache_behavior {
    path_pattern     = "*.html"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.website.id}"
    compress         = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 300  # 5 minutes for HTML files
    max_ttl     = 3600

    viewer_protocol_policy = "redirect-to-https"
  }

  # Custom error responses - serve 404 page for missing files
  custom_error_response {
    error_code         = 404
    response_code      = 404
    response_page_path = "/404.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code         = 403
    response_code      = 404
    response_page_path = "/404.html"
    error_caching_min_ttl = 300
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    # For custom domain, uncomment and configure ACM certificate:
    # acm_certificate_arn      = aws_acm_certificate.website.arn
    # ssl_support_method       = "sni-only"
    # minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-website-distribution"
    Environment = var.environment
  }
}

# Update S3 bucket policy to allow CloudFront OAC access only
resource "aws_s3_bucket_policy" "website_cloudfront" {
  bucket = aws_s3_bucket.website.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.website.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.website.arn
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_origin_access_control.website]
}

