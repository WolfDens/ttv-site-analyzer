# AGENTS.md — TTV Site Analyzer

Shared rulebook for the two agents that touch this repo:
- **Claude (Cowork)** — *author.* Implements changes, tests headless, opens the PR.
- **Codex** — *reviewer.* Reviews every PR against the guidelines below, flags P0/P1.
- **Brian** — *merge gate.* Reads Codex's findings + Claude's responses, then merges.

Both agents read this file. Claude follows it while writing; Codex enforces it while
reviewing. It is the single source of truth for "what good looks like" here — keep it
in the repo, version it with the code.

---

## Repo context (read before reviewing)

- **What it is:** an internal new-construction underwriting tool for Tide & Timber's
  Charlotte/Carolinas deals. A 7-step wizard: address → zoning → lot → buildable area →
  site costs → plan/build cost → financing → worst/base/best exit, plus feasibility
  screens and PDF/Excel/offer-letter exports.
- **Architecture:** a **single, fully client-side `index.html`** (UI + all logic + all
  plan data, ~4,775 lines) + **one** serverless function `api/gis.js` (Charlotte/Meck
  GIS proxy) + `plans/` images + `assets/` logos. No framework, no build step, no
  database. Everything runs in the browser.
- **Deploy model — why review matters:** Vercel serves the static files; **every push to
  `main` auto-deploys to production.** There is no build gate and no test suite catching
  regressions. The PR review *is* the safety net. Non-`main` branches get a Vercel
  **preview URL** — use it to eyeball the change live before merge.

---

## Review guidelines

Flag anything that violates these. They encode invariants a generic reviewer will miss.

### Pricing & scaling (highest-risk — these move real dollars)
- **`base` is the source of truth for cost; `c` is derived.** At load,
  `recomputePlanCosts()` sets `p.c = round(p.base × (1 + GC_fee%))` (default fee 14%),
  overwriting whatever literal `c:` each `PLANS` entry already carries — so the per-entry
  `c:` is a stale placeholder, not authoritative. Flag: reading or treating `c` as the
  source of truth, hand-editing `c` to change pricing (edit `base` instead), or any
  new/edited entry that bypasses `recomputePlanCosts()`. Do **not** flag the mere
  presence of a `c:` value — that's the normal data shape.
- **Footprint convention:** Slate publishes footprints as **(D′ × W′)**; `PLANS` store
  them **corrected** to `w=W, d=D`. Flag any new/edited plan whose width/depth looks
  transposed — a swap silently breaks every fit-check and BUA calc.
- **Scaling rule.** Per-**unit** costs scale ×N: build, upgrades, water tap, sewer tap.
  Per-**lot** costs stay singular ×1: lot factor, septic, survey, appraisal, insurance.
  Flag anything miscategorized (e.g. a per-lot cost multiplied by units).
- **Per-unit special cases stay intact:** Arcadia Triplex priced per unit
  ($416,608 ÷ 3) with the footprint kept as the whole 3-unit building; duets priced per
  side (`u:2`); townhomes per single unit (`u:1`). Flag changes that re-triple-count.

### Financing math (subtle — easy to "simplify" wrongly)
- **Preserve the circular loan solve.** `loan = LTC% × costBase / (1 − LTC%×0.01)`
  because purchase closing (1% of the loan) is itself inside the loan base. Flag any
  naive `loan = LTC% × costBase` that drops the closed-form term.
- **Max-supportable-land back-solve** targets a **$50,000** base profit/unit. Don't
  change that constant silently; if it changes, it's a deliberate, called-out change.

### Architecture & footguns
- **Stay single-file & buildless.** Flag any added framework, bundler, npm build step, or
  new runtime dependency. Export libs (`jsPDF`, `ExcelJS`) are **CDN, lazy-loaded only on
  export** — keep them that way.
- **Browser storage is limited to the two existing `localStorage` keys** — no others:
  `ttv-analyzer-last-seen-version` (release-notes gate) and `ttv-analyzer-autosave`
  (the v7.4 autosave/resume flow: `scheduleAutosave`, `resumeAutosave`,
  `checkResumeBanner`; writes degrade quietly when storage is unavailable). Flag any
  *new* storage key or any `sessionStorage` use, but do **not** flag routine maintenance
  of those two existing keys.
- **Don't hand-maintain derived data.** `p.val`, `PLAN_KEY_MAP`, `PLANS_FP` and all
  dropdowns are generated from the `const`s (`PLANS`, `SETBACKS`, `COUNTY_ZONES`…). Flag
  edits that set derived values by hand instead of regenerating them.
- **No secrets committed.** No tokens, keys, or private URLs in `index.html` or
  `api/gis.js`. The ArcGIS org URL is resolved at runtime from an item id
  (`cf66446f...`) on purpose — keep it that way; don't hard-code it.

### GIS proxy (`api/gis.js`)
- Auto-fill is **Mecklenburg-only** by design. Other counties link out to the county
  viewer — don't "fix" that into a broken universal fetch.
- Parcel area uses the **shoelace** of the geometry, **not** the bounding box. Flag a
  regression to bounding-box area.

### Domain-correctness (don't let geometry override the rulebook)
- Don't reintroduce **pre-UDO Mecklenburg UR-2/UR-3/UR-4** (defunct) into `SETBACKS`/
  `COUNTY_ZONES` — known data debt being removed, not added.
- Townhome/attached plays must be gated by the **permitted-use matrix**, not geometry
  alone (attached is not by-right in N1-A..E). Flag a recommendation that skips the gate.

### Versioning & verification (compensates for no test suite)
- Any user-facing change bumps **both** `APP_VERSION` and the header badge together, and
  adds a release-notes / changelog entry. Flag a mismatch.
- Because there's no automated test suite, **every logic change must include a manual
  verification note in the PR** — recompute one known deal (e.g. 2723 Dellinger Dr,
  PID 04118526: 77,575 sf, N1-B, Central Catawba) and show the before/after numbers.
  Flag a math-touching PR that ships without one.

---

## PR protocol (the handoff surface between the agents)

1. **Claude** branches off `main` (never commits straight to `main`), implements, tests
   headless, and opens a PR whose description states **what changed, why, and the manual
   verification numbers**.
2. **Codex** auto-reviews against this file and posts P0/P1 findings. Focused passes on
   request: `@codex review for financing-math regressions`.
3. **Claude** responds to each finding in-thread — fix, or justify why it's a
   non-issue — and pushes follow-up commits.
4. **Brian** reads the resolved thread + the Vercel preview, then merges → Vercel deploys.

Nothing reaches production without passing through this loop.
