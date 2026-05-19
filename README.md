# A Light in the Sky — marketing site

Static HTML/CSS marketing site. No build step. Deploys directly on Vercel.

## Files

- `index.html` — entire homepage
- `colors_and_type.css` — design tokens (palette, type scale, spacing, radii, shadows, motion)
- `kit.css` — component styles + responsive breakpoints
- `assets/` — logo SVGs

## Local preview

Open `index.html` in a browser. Or:

```
npx serve .
```

## Deploy

Pushes to `main` auto-deploy via Vercel (project: `alitsky` → GitHub: `thisissahir/alitsky`). Vercel needs no build command and no output directory — it serves the repo root as static files.
