# A Light in the Sky — marketing site

Static HTML/CSS marketing site with a single Vercel Serverless Function for the
audit form. Deploys on Vercel from the repo root — no framework, no build step.

## Files

### Pages
- `index.html` — homepage
- `audit.html` — `/audit` business analysis form
- `thank-you.html` — `/thank-you` form-submitted confirmation
- `about.html`, `case-studies.html`, `pricing.html` — placeholders
- `services/websites.html` — `/services/websites`
- `services/ai-receptionist.html` — `/services/ai-receptionist`
- `services/ai-seo.html` — `/services/ai-seo`
- `services/automations.html` — `/services/automations`
- `services/analysis.html` — `/services/analysis` (with embedded audit form)

### Assets and shared code
- `colors_and_type.css` — design tokens (palette, type scale, spacing, radii, shadows)
- `kit.css` — component styles + responsive breakpoints
- `count-up.js` — IntersectionObserver-driven count-up for case study stats
- `audit-form.js` — POSTs the audit form to `/api/audit`, redirects to `/thank-you`
- `assets/` — logo SVGs

### Server
- `api/audit.js` — Vercel Serverless Function. Receives form POST, sends mail via Resend.
- `package.json` — declares `resend` as a dependency so Vercel installs it on deploy.
- `.env.local.example` — template for local dev env vars.

## Local preview

For the static pages, any static server works:

```
npx serve .
```

To test `/api/audit` locally you need the Vercel CLI:

```
npm install -g vercel
vercel dev
```

`vercel dev` reads `.env.local` for `RESEND_API_KEY`.

## Deploy

Pushes to `main` auto-deploy via Vercel
(project: `alitsky` → GitHub: `thisissahir/alitsky`).

Vercel configuration:
- **Framework Preset:** Other
- **Build Command:** none (leave empty)
- **Output Directory:** `./` (or leave empty)
- Vercel auto-detects `api/*.js` as serverless functions and installs `package.json` deps.

## Environment variables — required for the audit form

The form will return 500 until you set these in Vercel
(**Settings → Environment Variables**):

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | yes | — | Sign up free at https://resend.com, create an API key, paste here. |
| `AUDIT_TO_EMAIL` | no | `admin@alitsky.com` | Where audit submissions are delivered. |
| `AUDIT_FROM_EMAIL` | no | `A Light in the Sky <onboarding@resend.dev>` | Sender. Use `onboarding@resend.dev` until you verify the `alitsky.com` domain in Resend. After verification, set this to `A Light in the Sky <audit@alitsky.com>`. |

After setting/changing env vars, **redeploy** so the new values take effect
(Vercel does not pick up env-var changes mid-flight).

### Verifying the alitsky.com domain in Resend

Until verified, Resend will only send from `onboarding@resend.dev`. To send from
your own domain:

1. In Resend → Domains → Add Domain → `alitsky.com`.
2. Resend gives you DNS records (SPF, DKIM, optionally DMARC).
3. Add those records at your DNS provider (Cloudflare, Namecheap, etc).
4. Resend marks the domain "Verified" once it sees them.
5. Update `AUDIT_FROM_EMAIL` in Vercel → redeploy.
