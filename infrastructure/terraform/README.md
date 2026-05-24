# Bondfires Terraform Infrastructure

> **Note:** The Bondfires marketing website lives in [bondfires-website](https://github.com/deggertsen/bondfires-website) and is hosted on Cloudflare Pages. This Terraform stack is legacy and can be destroyed once `bondfires.org` is confirmed live on Pages.

This Terraform configuration previously managed AWS S3 + CloudFront for the Bondfires website.

## Resources Created

- **S3 Bucket**: Static website hosting origin
- **CloudFront Distribution**: HTTPS and global CDN for the website
- **Origin Access Control**: Private S3 access from CloudFront

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

### Get Website Outputs

After applying, get the website deployment details:

```bash
terraform output
```

## Security

- Website S3 bucket blocks public access
- CloudFront uses Origin Access Control for private bucket reads
- Server-side encryption (AES-256) is enabled where configured
