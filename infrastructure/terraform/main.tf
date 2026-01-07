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

