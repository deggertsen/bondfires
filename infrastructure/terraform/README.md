# Bondfires Terraform Infrastructure

This Terraform configuration manages the AWS infrastructure for the Bondfires app.

## Resources Created

- **S3 Bucket**: Video storage with versioning, encryption, and CORS
- **IAM User**: Service account for Convex to access S3
- **IAM Policy**: Permissions for generating presigned URLs

## Prerequisites

- [Terraform](https://www.terraform.io/downloads.html) >= 1.0
- AWS CLI configured with appropriate credentials
- An AWS account

## Usage

### Initialize Terraform

```bash
cd infrastructure/terraform
terraform init
```

### Plan Changes

```bash
terraform plan -var-file=environments/prod/prod.tfvars
```

### Apply Changes

```bash
terraform apply -var-file=environments/prod/prod.tfvars
```

### Get Convex Credentials

After applying, get the credentials for Convex:

```bash
terraform output -json convex_environment_variables
```

## Setting Up Convex

1. Run `terraform apply` to create the AWS resources
2. Run `terraform output -json convex_environment_variables` to get credentials
3. Go to [Convex Dashboard](https://dashboard.convex.dev)
4. Navigate to Settings > Environment Variables
5. Add the following variables:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `S3_BUCKET_NAME`

## Cost Optimization

The S3 bucket includes lifecycle rules:
- Objects transition to Infrequent Access after 30 days
- Old versions are deleted after 30 days
- Incomplete multipart uploads are cleaned up after 7 days

## Security

- S3 bucket blocks all public access
- Server-side encryption (AES-256) is enabled
- IAM user has minimal required permissions
- Credentials can optionally be stored in AWS Secrets Manager

