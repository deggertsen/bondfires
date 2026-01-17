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
├── 404.html                    # Custom 404 error page
├── css/
│   ├── variables.css           # CSS custom properties (design tokens)
│   └── styles.css              # Main styles
├── js/
│   └── main.js                 # Mobile nav, interactions
├── images/                     # Placeholder directory for assets
└── README.md                   # This file (excluded from deployment)
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

### Before First Deployment

1. **Update OG Image URLs:** Edit `index.html` and replace `https://bondfires.org/` with your actual domain (CloudFront URL or custom domain).

2. **Add Required Assets:**
   - `images/og-image.png` - Social sharing preview image (1200x630px recommended)
   - Replace placeholder logo SVG with actual logo if available

### Deploy to S3

Deploy from the **repository root** directory (not from `apps/website/`):

```bash
# From repository root
aws s3 sync apps/website/ s3://YOUR_BUCKET_NAME/ \
  --delete \
  --cache-control "max-age=31536000" \
  --exclude "*.html" \
  --exclude "README.md"

# Upload HTML files with shorter cache and correct content type
aws s3 sync apps/website/ s3://YOUR_BUCKET_NAME/ \
  --exclude "*" \
  --include "*.html" \
  --content-type "text/html" \
  --cache-control "max-age=300"
```

Replace `YOUR_BUCKET_NAME` with the bucket name from Terraform output.

**Note:**

- `--delete` removes files from S3 that no longer exist locally
- HTML files get a 5-minute cache; assets get 1-year cache (CloudFront will invalidate)
- `README.md` is excluded from deployment

### Invalidate CloudFront Cache

After deploying, invalidate the CloudFront cache to ensure changes are visible immediately:

```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

Replace `YOUR_DISTRIBUTION_ID` with the distribution ID from Terraform output.

### Complete Deployment Script

Create a deployment script at the **repository root** (e.g., `scripts/deploy-website.sh`):

```bash
#!/bin/bash
set -e

# Configuration - update these or use terraform output
BUCKET_NAME="${WEBSITE_BUCKET_NAME:-$(cd infrastructure/terraform && terraform output -raw website_bucket_name)}"
DISTRIBUTION_ID="${WEBSITE_DISTRIBUTION_ID:-$(cd infrastructure/terraform && terraform output -raw website_cloudfront_distribution_id)}"

echo "Deploying website to S3 bucket: $BUCKET_NAME"

# Sync static assets (long cache)
aws s3 sync apps/website/ s3://$BUCKET_NAME/ \
  --delete \
  --cache-control "max-age=31536000" \
  --exclude "*.html" \
  --exclude "README.md"

# Sync HTML files (short cache, explicit content type)
aws s3 sync apps/website/ s3://$BUCKET_NAME/ \
  --exclude "*" \
  --include "*.html" \
  --content-type "text/html" \
  --cache-control "max-age=300"

echo "Invalidating CloudFront distribution: $DISTRIBUTION_ID"
aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"

echo ""
echo "Deployment complete!"
echo "Website URL: https://$(cd infrastructure/terraform && terraform output -raw website_cloudfront_domain_name)"
```

Make it executable and run:

```bash
chmod +x scripts/deploy-website.sh
./scripts/deploy-website.sh
```

### Quick Deploy (One-liner)

From repository root:

```bash
BUCKET=$(cd infrastructure/terraform && terraform output -raw website_bucket_name) && \
DIST=$(cd infrastructure/terraform && terraform output -raw website_cloudfront_distribution_id) && \
aws s3 sync apps/website/ s3://$BUCKET/ --delete --exclude "README.md" && \
aws cloudfront create-invalidation --distribution-id $DIST --paths "/*"
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
- **OG Image:** Social sharing preview image (`images/og-image.png`) - Required for social media sharing
  - Recommended size: 1200x630px
  - Update the absolute URL in `index.html` meta tags with your domain
- **App Store Badges:** iOS and Android download badges in `download.html`
  - Get official badges from [Apple](https://developer.apple.com/app-store/marketing/guidelines/) and [Google](https://play.google.com/intl/en_us/badges/)
- **QR Codes:** App store QR codes in `download.html`
- **Favicon:** Add `favicon.ico` to the root directory

All placeholders are clearly marked with comments in the HTML.

### Important: OG Image URLs

The `og:image` and `twitter:image` meta tags in `index.html` require **absolute URLs** (e.g., `https://bondfires.org/images/og-image.png`). Update these with your actual domain before deployment.

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

Copyright © 2026 Bondfires. All rights reserved.
