# TTV Site Analyzer

Internal new-construction underwriting tool for Tide & Timber Ventures (Charlotte / Carolinas).
A single, fully client-side `index.html` — no backend, no database, no build step.

**Live:** deploys automatically on every push to `main` (Vercel, static).

## Deploy (one-time setup)

1. Push this folder to a new GitHub repo (e.g. `ttv-site-analyzer`).
2. In Vercel → **Add New → Project → Import** the repo.
   - Framework Preset: **Other** (it's static; no build command, output dir = root).
3. Done. Every future push to `main` auto-deploys. Push to any other branch to get a
   preview URL before it goes live.

No `vercel.json` is needed — Vercel serves the static files as-is.

## Structure

```
index.html      # the entire app (UI + logic + plan data)
plans/          # plan images (one per Slate plan) — see plans/README.md
README.md
```

## Updating

- **The app:** edit `index.html`, push. That's it.
- **Plan library / pricing:** the master `PLANS` array lives near the top of the
  `<script>` block in `index.html`. Each entry is
  `{n, sf, c, u, w, d, t, g}` (name, sq ft, cost, units, footprint width, depth, type, group).
  The plan dropdown, fit-check grid, and comparison tool are all generated from it.
  Current pricing source: Slate "FINAL One Sheet" (Cost + 14% column).
- **Version badge:** the `hdr-badge` in the header (top of `index.html`).

## Plan images (feature #5)

36 plan images live in `/plans` (full brochure page per plan) and are wired into the
tool: a camera button on each fit-check card, a "View plan drawing" button on Step 5,
and "View" in the comparison — all open a lightbox. See `plans/README.md` for the map.
