# Plan images

One image per Slate plan (full brochure page: front elevation + floor plans + SQ FT),
used for the plan-photo feature (camera button on fit cards, "View plan drawing" on
Step 5, and "View" in the comparison). Clicking opens a lightbox.

- Source: "ALL SLATE BROCHURES 4-6-26.pdf" (one plan per page), rendered to ~1400px WebP.
- Naming: by plan slug, e.g. `powell.webp`, `arlington.webp`, `oxford.webp`.
- The plan -> file map lives in `index.html` (`PLAN_IMG`).
- Spec/variant plans reuse a base elevation: Dublin 1/2 Car -> `dublin`,
  Hudson -> `westerville`, Laurel -> `grandview`, Wildwood -> `arlington`.
- No brochure page (no image): Akron, Arcadia Duet, Arcadia Triplex. `canton.webp`
  exists but Canton isn't in the library yet (no price/footprint).

Served statically by Vercel; referenced as `plans/<name>.webp` — no base64.
