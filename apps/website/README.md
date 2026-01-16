# Bondfires Website

A static marketing website for Bondfires, built with vanilla HTML/CSS/JS and hosted on AWS S3 with CloudFront for HTTPS and global CDN.

## Project Structure

```
apps/website/
├── index.html                  # Homepage
├── how-it-works.html           # How It Works page
├── about.html                  # About page
├── download.html               # Download page
├── faq.html                    # FAQ page
├── privacy.html                # Privacy Policy
├── terms.html                  # Terms of Service
├── community-guidelines.html   # Community Guidelines
├── css/
│   ├── variables.css           # CSS custom properties (design tokens)
│   └── styles.css              # Main styles
├── js/
│   └── main.js                 # Mobile nav, interactions
├── images/                     # Placeholder directory for assets
└── README.md                   # This file
```

## Design System

The website uses design tokens from the Bondfires Brand Kit. All colors, spacing, and typography are defined in `css/variables.css` based on:

- **Primary Color:** Bondfire Copper (#D97736)
- **Background:** Obsidian (#141416)
- **Surface:** Gunmetal (#1F2023)
- **Text:** White Smoke (#F3F4F6)
- **Text Muted:** Ash (#9CA3AF)

See `css/variables.css` for complete design system definitions.

## Development

### Local Development

Since this is a static site, you can develop locally by:

1. Opening HTML files directly in a browser, or
2. Using a local HTTP server:

```bash
# Using Python
cd apps/website
python3 -m http.server 8000

# Using Node.js (if you have http-server installed)
npx http-server -p 8000

# Using PHP
php -S localhost:8000
```

Then visit `http://localhost:8000` in your browser.

### Making Changes

1. **Content:** Edit HTML files directly
2. **Styles:** Modify `css/styles.css` or `css/variables.css`
3. **Interactions:** Update `js/main.js`
4. **Assets:** Replace placeholders in `images/` directory

## Deployment

### Prerequisites

1. **AWS CLI configured** with appropriate credentials
2. **Terraform applied** to create S3 bucket and CloudFront distribution

Get your deployment details from Terraform outputs:

```bash
cd infrastructure/terraform
terraform output website_bucket_name
terraform output website_cloudfront_distribution_id
terraform output website_url
```

### Deploy to S3

Deploy all files to S3:

```bash
cd apps/website
aws s3 sync . s3://YOUR_BUCKET_NAME --delete
```

Replace `YOUR_BUCKET_NAME` with the bucket name from Terraform output.

**Note:** Use `--delete` to remove files from S3 that no longer exist locally.

### Invalidate CloudFront Cache

After deploying, invalidate the CloudFront cache to ensure changes are visible immediately:

```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

Replace `YOUR_DISTRIBUTION_ID` with the distribution ID from Terraform output.

### Complete Deployment Script

Create a deployment script (e.g., `deploy.sh`):

```bash
#!/bin/bash

# Get Terraform outputs
BUCKET_NAME=$(cd ../../infrastructure/terraform && terraform output -raw website_bucket_name)
DISTRIBUTION_ID=$(cd ../../infrastructure/terraform && terraform output -raw website_cloudfront_distribution_id)

# Deploy to S3
echo "Deploying to S3 bucket: $BUCKET_NAME"
aws s3 sync . s3://$BUCKET_NAME --delete

# Invalidate CloudFront
echo "Invalidating CloudFront distribution: $DISTRIBUTION_ID"
aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"

echo "Deployment complete!"
```

Make it executable and run:

```bash
chmod +x deploy.sh
./deploy.sh
```

## Infrastructure

The website infrastructure is managed by Terraform in `infrastructure/terraform/`. It includes:

- **S3 Bucket:** For static website hosting
- **CloudFront Distribution:** For HTTPS, CDN, and global distribution
- **Origin Access Control (OAC):** For secure S3 access (bucket is not publicly accessible)

### Setting Up Infrastructure

1. Navigate to Terraform directory:

   ```bash
   cd infrastructure/terraform
   ```

2. Initialize Terraform:

   ```bash
   terraform init
   ```

3. Review the plan:

   ```bash
   terraform plan
   ```

4. Apply the infrastructure:

   ```bash
   terraform apply
   ```

5. Get deployment outputs:
   ```bash
   terraform output website_deployment_instructions
   ```

## Assets & Placeholders

The following assets are currently placeholders and should be replaced:

- **Logo:** Inline SVG flame icon in navigation (replace with actual logo)
- **OG Image:** Social sharing preview image (`images/og-image.png`)
- **App Store Badges:** iOS and Android download badges in `download.html`
- **QR Codes:** App store QR codes in `download.html`

All placeholders are clearly marked with comments in the HTML.

## Features

- ✅ Mobile-first responsive design
- ✅ Accessibility (WCAG 2.1 AA compliance)
- ✅ SEO meta tags and structured data
- ✅ Mobile navigation with hamburger menu
- ✅ Smooth scroll and interactions
- ✅ Brand-consistent design system
- ✅ Fast performance (static HTML/CSS/JS)
- ✅ HTTPS via CloudFront
- ✅ Global CDN distribution

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Responsive design for all screen sizes

## License

Copyright © 2024 Bondfires. All rights reserved.
