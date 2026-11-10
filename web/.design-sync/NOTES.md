# design-sync NOTES — Native Intelligence Design System (@native-intelligence/ui)

Repo-specific gotchas for future syncs. Read this first.

## What this kit is

`@native-intelligence/ui` is a workspace package (`packages/ui/`) **built from the app's own source**.
The app is a Next.js app (`radiant`) with no standalone component library, so instead of
moving files, the package re-exports the presentational components from
`<repo>/src/components/**` via the `@/` alias and compiles them with tsup into a real
`dist/` (entry + `.d.ts`) plus a static `dist/styles.css` (Tailwind v4 CLI). The app is
unchanged and still imports `@/components/ui/*` directly.

- Public API / what gets synced: `packages/ui/src/index.ts` (the barrel).
- Build: `npm run build --workspace @native-intelligence/ui` (→ `build:js` tsup + `build:css` tailwind cli).
- design-sync entry: `--entry ./packages/ui/dist/index.js`, `--node-modules ./node_modules`
  (deps are hoisted to the repo root; `@native-intelligence/ui` is symlinked into root node_modules).
- `cfg.cssEntry` is **package-relative** (`dist/styles.css`), NOT repo-relative — the
  converter resolves it against PKG_DIR (= `packages/ui`). A repo-relative path prints
  "cssEntry … not found — skipped".

## Deliberately excluded from the kit

- **Heavy AI chat-output renderers** (commented out in the barrel): `code-block` (shiki —
  ~8MB of langs/themes), `markdown` (remark stack), `message`, `reasoning`,
  `response-stream`, `chat-container`. With them in, `_ds_bundle.js` was 12.5MB and the
  upload rejects >5MB. Without them it's 2.5MB. They still live in the app; re-add to the
  barrel only if they ever need design-system cards (and slim the deps first).
- **App-coupled components** never entered the package: anything under `capture/`, `views/`,
  `onboarding-*`, and top-level dialogs that reach `@/app/account`, stores, tauri, or
  `@/lib/*` business logic. They can't render standalone. The barrel only carries the 48
  shadcn `ui/` primitives (minus the 6 above) + 15 clean marketing components.
- `markdown-table` (exports a config object, not a component) — not in barrel.
- Marketing `button.tsx` (collides with `ui/button` Button) and `link.tsx` (pulls
  `next/link`, no router in the preview runtime) — excluded.

## Fonts (SHIPPED — do not revert to runtimeFontPrefixes)

Kit uses `Inter` (sans) and `Noto Serif` (heading). The APP loads these via Next/Google
fonts at runtime, so there's no woff2 in `node_modules`/`public` to harvest. We ship them
explicitly instead: `packages/ui/fonts/` holds the two **variable** woff2 files
(`Inter-var.woff2`, `NotoSerif-var.woff2`, weight-range `@font-face`) + `fonts.css`, and
`cfg.extraFonts: "fonts/fonts.css"` (package-relative) wires them in — the converter copies
them to the bundle's `fonts/` and adds `@import "./fonts/fonts.css"` to `styles.css`.
- They're the open-licensed (OFL) Google variable fonts, latin subset only, fetched once
  from the gstatic CDN. To refresh: `curl` the `css2?family=...:wght@100..900` CSS with a
  modern UA, take the `latin` `@font-face` block, download its single variable woff2.
- An earlier attempt pinned single weights and got 4 byte-identical files (Google serves
  one variable font for all weights) — use the variable axis, one file per family.
- NOTE: the first sync used `cfg.runtimeFontPrefixes` (system fallback). That's GONE — we
  ship the real fonts now. Don't re-add runtimeFontPrefixes.

## Card pruning (cfg.componentSrcMap)

The barrel still EXPORTS all 223 components (sub-parts stay importable so the design agent
can compose `DropdownMenuItem` inside `DropdownMenu`), but `cfg.componentSrcMap` sets ~167
sub-parts/glyphs to `null` so they DON'T get their own preview card. Result: 56 cards, each
a distinct standalone component, instead of 223 mostly-identical floor cards. The dropped
set = all Radix sub-parts (`*Trigger`/`*Content`/`*Item`/`*Header`/`*Title`…), Sidebar
internals, Table cells, Form fields, Select parts, glyphs (`Mark`/`DotGlyph`/`ProjectIcon`),
and text sub-parts (`Subheading`/`Lead`, shown inside the `Heading` card). Kept standalone:
`AvatarGroup`, `ToggleGroup`. If a future sync re-adds a sub-part as a card, drop its
`componentSrcMap: null` entry.

## Preview authoring notes (from the first sync's fan-out)

- **Overlays need `cardMode: single` in the LIVE claude.ai/design pane** (corrected). The
  capture harness scopes each portal to its own cell for the contact-sheet screenshot, so
  multi-cell overlays LOOK fine there — but in the live DS pane the cells render side-by-side
  in a grid and the open portal (absolutely-positioned `DropdownMenuContent`/`SelectContent`/
  dialog backdrop) escapes its cell and overlaps the neighbor. Fix: `cfg.overrides.<Name> =
  {cardMode:"single", primaryStory:"<open cell>", viewport:"WxH"}`. Applied to Dialog,
  AlertDialog, DropdownMenu, Popover, Select, Tooltip (primaryStory "Open"/"Default").
  Verify in the live pane, NOT just the contact sheet — the contact sheet hid this.
  Do NOT hand-roll inline overlay bodies with `var(--background)` — they render white-on-white.
- **Full-width marketing components** (Container, LogoCloud) must use `width:'100%'` in their
  preview wrapper, NOT a fixed px width — a fixed 900/720px cell overflows the card and
  overlaps its neighbor. Also given `cardMode:single` so they get the full card width.
- **Tooltip**: supply `<TooltipProvider>` inside the preview (kept scoped) rather than via
  `cfg.provider`.
- **Loaders are tiny and animate** — a lone spinner captures as RENDER_BLANK. Author them
  LARGE (`size="lg"`), several-per-card with captions, on a visible surface, + an in-context
  cell. All loader PNGs then land ~19–24KB.
- **framer-motion `whileInView` blanks in headless capture** (FeatureCard, FeatureGrid):
  they mount at `opacity:0` and only reveal on IntersectionObserver, which never fires in
  the single-frame capture. Fix lives IN those previews: a tiny injected
  `<style>.rounded-2xl.border{opacity:1!important;transform:none!important}</style>`.
  This pattern recurs for ANY `whileInView`/`useInView`-gated component added later.
- **.d.ts under-reports native passthrough props** for Input/Textarea (placeholder,
  defaultValue, disabled, rows) and Calendar (`selected`) and Accordion (`collapsible`).
  They work — they're native/Radix passthroughs. Don't trust the generated contract as
  exhaustive for native-element wrappers.

## Preview sizing — VERIFY AT NARROW CARD WIDTH (hard-won)

The live claude.ai/design pane renders each card narrower than the contact-sheet/capture
viewport, and lays multi-cell previews out in a `minmax(320px,1fr)` grid. Two failure modes
that the WIDE contact sheet completely hid (looked fine there, broke live):
- **Fixed pixel widths** in a preview wrapper (`width: 380/420/520`) overflow the ~320–360px
  cell and overlap the neighbor. RULE: never use a fixed px width wider than ~300px in a
  preview — use `width:'100%'` with a `maxWidth` cap. All previews were swept for this.
- **Components with no intrinsic width** (e.g. `AnimatedNumber` = a bare framer `motion.span`
  whose transform collapses to 0 width) overlap when placed in flex siblings. Give each a
  `minWidth` and `flexWrap:'wrap'` the row.
- **True modals** (`Dialog`, `AlertDialog`) use `position:fixed inset-0` — the open state
  ALWAYS escapes the card (dark backdrop fills the card, dialog centers on the iframe
  viewport). Do NOT show them open. Lead with the **trigger (closed)** state — a real render
  of the component (the button). The open composition stays in `.prompt.md` for Claude.
  (Anchored overlays — DropdownMenu/Select/Popover/Tooltip — are fine open: they anchor to
  the trigger, not `fixed`. Keep those on `cardMode:single` so the floating content has room.)

VERIFICATION METHOD (do this, not the contact sheet): render each card's `.html` at the true
card width and eyeball it. Throwaway harness:
```
// cardshot.mjs at repo root (playwright-core resolves there, not /tmp)
import { chromium } from 'playwright-core';
const comps = process.argv[2].split(','); const W = Number(process.argv[3]||760);
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:W,height:900},deviceScaleFactor:2});
for (const c of comps){ await p.goto('file://'+process.cwd()+`/ds-bundle/components/general/${c}/${c}.html`); await p.waitForTimeout(900); await p.screenshot({path:`/tmp/card-${c}.png`,fullPage:true}); }
await b.close();
```
Run `PLAYWRIGHT_BROWSERS_PATH=0 node cardshot.mjs Comp1,Comp2 760`. 760px ≈ the live card.

## Re-sync risks (watch-list)

- **LogoCloud previews show alt-text, not logos.** It references app-local
  `/logo-timeline/*.svg` from `public/`, which the preview server doesn't serve, so tiles
  404 to alt text. Structure/layout render fine (graded good). To fix: serve `public/` from
  the preview server, or point the preview at real https logo URLs. Cosmetic only.
- **Authored previews are tied to upstream component APIs.** If a `ui/` primitive's props
  change in the app, its `previews/<Name>.tsx` may need updating. Previews import from
  `'@native-intelligence/ui'` so they track the barrel.
- **The 5MB ceiling is a standing constraint.** If you re-add any heavy dep (shiki,
  remark, a 3D/charting lib) to the barrel, re-check `_ds_bundle.js` size before upload.
- **Build assumes Node 22** (`.nvmrc`) and Tailwind v4. tsup/@tailwindcss/cli are
  `packages/ui` devDeps.
- **Chromium for the render check** installs into `node_modules/playwright-core/.local-browsers/`
  via `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`. Pass that env var to
  validate/capture so they find it.
- Floor-card components (everything not in the ~43 authored set) are the standing offer for
  incremental authoring on any future re-sync — authored files + grades carry forward.
