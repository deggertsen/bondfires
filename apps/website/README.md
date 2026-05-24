# Bondfires Website

A static marketing website for Bondfires, built with vanilla HTML/CSS/JS and hosted on [Cloudflare Pages](https://pages.cloudflare.com/).

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
├── child-safety.html           # Child Safety
├── delete-account.html         # Account Deletion
├── 404.html                    # Custom 404 error page
├── _headers                    # Cloudflare Pages cache headers
├── wrangler.toml               # Cloudflare Pages / Wrangler config
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

## Deployment (Cloudflare Pages)

The site is a plain static directory — no build step required.

### Option A: Git integration (recommended)

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Workers & Pages → Create → Pages → Connect to Git**
2. Select the `bondfires` repository
3. Configure the project:
   - **Project name:** `bondfires-website`
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** leave empty
   - **Root directory:** `apps/website`
4. Deploy. Every push to `main` will publish automatically.
5. Attach custom domains under **Custom domains**:
   - `bondfires.org`
   - `www.bondfires.org`

Cloudflare Pages serves `404.html` automatically and applies cache rules from `_headers`.

### Option B: Manual deploy with Wrangler

Useful for one-off deploys or before Git integration is wired up.

```bash
# From repository root
export CLOUDFLARE_API_TOKEN=your-token
yarn deploy:website
```

Create an API token at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) with **Cloudflare Pages → Edit** permission.

### DNS for bondfires.org

DNS for `bondfires.org` is already on Cloudflare. Once the Pages project exists:

1. Open the Pages project → **Custom domains**
2. Add `bondfires.org` and `www.bondfires.org`
3. Cloudflare will create/update the DNS records for you
4. Remove any old records pointing at AWS CloudFront or a broken origin (a misconfigured origin causes Cloudflare error **1016** / HTTP **530**)

If you previously had manual DNS records (A/CNAME) pointing at CloudFront, delete those after the Pages custom domain is active.

### Before First Deployment

1. **OG image URLs:** `index.html` already uses `https://bondfires.org/` — keep that once the custom domain is live.
2. **Add required assets:**
   - `images/og-image.png` — social sharing preview (1200x630px recommended)
   - Replace placeholder logo SVG with actual logo if available

## Legacy AWS hosting

The previous setup used AWS S3 + CloudFront, managed in `infrastructure/terraform/`. That stack can be torn down after Cloudflare Pages is live:

```bash
cd infrastructure/terraform
terraform destroy -var-file=environments/prod/prod.tfvars
```

Only run this once `https://bondfires.org` is serving correctly from Pages.

## Assets & Placeholders

The following assets are currently placeholders and should be replaced:

- **Logo:** Inline SVG flame icon in navigation (replace with actual logo)
- **OG Image:** Social sharing preview image (`images/og-image.png`)
  - Recommended size: 1200x630px
- **App Store Badges:** iOS and Android download badges in `download.html`
- **QR Codes:** App store QR codes in `download.html`
- **Favicon:** Add `favicon.ico` to the root directory

All placeholders are clearly marked with comments in the HTML.

## Features

- Mobile-first responsive design
- Accessibility (WCAG 2.1 AA compliance)
- SEO meta tags and structured data
- Mobile navigation with hamburger menu
- Smooth scroll and interactions
- Brand-consistent design system
- Fast performance (static HTML/CSS/JS)
- HTTPS and global CDN via Cloudflare Pages

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Responsive design for all screen sizes

## License

Copyright © 2026 Bondfires. All rights reserved.
