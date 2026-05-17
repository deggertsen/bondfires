# Email Deliverability

Bondfires signup verification and password reset emails are sent by Convex Auth through Resend. The app requests the OTP from Convex; delivery quality is controlled by the Resend sender domain, DNS authentication, and mailbox-provider reputation.

## Current Sending Path

- Signup calls Convex Auth with the password provider in `convex/auth.ts`.
- Convex Auth sends the verification OTP through Resend using `RESEND_API_KEY`.
- `EMAIL_FROM` controls the sender address. If it is not set, the code falls back to `Bondfires <noreply@bondfires.org>`.
- `convex/email.ts` uses the same Resend environment variables for other transactional emails.

## Yahoo Delivery Investigation

Jake reported that Gmail received a signup verification email, but Yahoo did not. That means the app signup flow and the Resend API request are working; the Yahoo-specific failure is most likely mailbox-provider filtering or sender-domain authentication.

Public DNS observed on 2026-05-16:

```text
bondfires.org TXT: v=spf1 include:_spf.mx.cloudflare.net ~all
_dmarc.bondfires.org TXT: v=DMARC1; p=none;
resend._domainkey.bondfires.org TXT: present
bounce.bondfires.org TXT: not present
```

The important gap is that the root SPF record authorizes Cloudflare mail, but does not visibly authorize Resend. Resend also recommends fully verified SPF and DKIM records for the sending domain, and a DMARC record to build trust with mailbox providers.

## Required Production Setup

1. In the Resend dashboard, open the sending domain currently used by `EMAIL_FROM`.
2. Confirm the domain status is verified and that both SPF and DKIM show as verified.
3. If sending from `noreply@bondfires.org`, update the existing root SPF TXT record so it includes Resend exactly as shown by the Resend dashboard, while preserving the Cloudflare include already used for inbound/domain email.
4. Prefer a dedicated transactional subdomain if Resend offers one for this account, for example `mail.bondfires.org` or `updates.bondfires.org`. Configure all Resend-required DNS records on that subdomain, then set Convex `EMAIL_FROM` to an address on that verified subdomain.
5. Configure the Resend bounce/return-path record if the dashboard provides one. This improves alignment and makes Yahoo/Postmaster diagnostics clearer.
6. Keep DMARC enabled. Start with monitoring (`p=none`) while testing, then move toward `quarantine` or `reject` only after SPF/DKIM alignment is confirmed across Gmail, Yahoo, iCloud, and Outlook.
7. Send fresh signup OTP tests to Yahoo, Gmail, iCloud, and Outlook. In Resend logs, inspect the Yahoo event status. If Resend shows `delivered` but Yahoo inbox does not show it, check Yahoo spam/promotions folders and collect the message headers from any received copy for SPF/DKIM/DMARC alignment.

## Convex Environment Variables

Set these in the Convex dashboard for every deployed environment that sends auth email:

```env
RESEND_API_KEY=re_...
EMAIL_FROM=Bondfires <noreply@bondfires.org>
```

Use an `EMAIL_FROM` domain that is verified in Resend. Do not use a free mailbox provider address such as Gmail or Yahoo as the sender.

## Verification Commands

Use these from a terminal to inspect the public DNS state after provider changes propagate:

```bash
dig +short TXT bondfires.org
dig +short TXT _dmarc.bondfires.org
dig +short TXT resend._domainkey.bondfires.org
dig +short TXT bounce.bondfires.org
```

Adjust the hostnames if `EMAIL_FROM` moves to a sending subdomain.
