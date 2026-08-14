# Vibe Tree Lite theme packs

Vibe Tree Lite theme packs are local, declarative packages. Schema 1 packs are
CSS-token-only and can change the dashboard's colors, surfaces, shadows,
typography, radii, background, metric cards, and chart palette without changing
HTML or JavaScript. Schema 2 adds an optional, sandboxed mascot asset that can
appear in the fixed `chart-rail` slot; a pack can request a fixed decorative
pet or host-owned ambient motion, but it still does not load theme JavaScript.

## Package layout

```text
themes/
  my-theme/
    theme.json
    theme.css
    assets/
      mascot.png       # schema 2 only; transparent PNG
```

The directory name and manifest `id` must match. IDs use lowercase ASCII
letters, digits, and hyphens, with a maximum of 64 characters.

## Install directories

- macOS: `~/Library/Application Support/Vibe Tree/themes/<theme-id>/`
- Windows: `%APPDATA%\Vibe Tree\themes\<theme-id>\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Vibe Tree/themes/<theme-id>/`

Refresh the dashboard after copying or removing a pack. Select it from the
**主题** control in the top bar. Selection is written to `lite-theme.json` in
the same Vibe Tree data directory and survives service restarts.

## Manifest

`theme.json` uses schema version 1 for CSS-only packs:

```json
{
  "schemaVersion": 1,
  "id": "my-theme",
  "name": "我的主题",
  "subtitle": "My Theme",
  "description": "A short local description.",
  "author": "Your Name",
  "version": "1.0.0",
  "colorScheme": "light",
  "entry": "theme.css"
}
```

`colorScheme` is `light` or `dark`. The stylesheet entry is fixed to
`theme.css`; alternate or nested entries are not accepted.

### Mascot extension (schema 2)

Schema 2 keeps the same metadata and token requirements, but adds one mascot
declaration. The asset path is relative to the pack and must be a local PNG
under `assets/`, with an alpha channel. Lite bounds it to 2 MiB, 2048 × 2048
pixels, and 4 million total pixels. The only supported placement is the
`chart-rail` slot below the token chart. This intentionally gives a theme a
small expressive “desktop pet” surface while keeping the dashboard layout,
network policy, and application code controlled by Lite.

```json
{
  "schemaVersion": 2,
  "id": "ginger-focus",
  "name": "橘猫专注",
  "subtitle": "Ginger Focus",
  "description": "A working orange cat for the chart rail.",
  "author": "Your Name",
  "version": "1.0.0",
  "colorScheme": "light",
  "entry": "theme.css",
  "mascot": {
    "asset": "assets/mascot.png",
    "slot": "chart-rail",
    "motion": "static",
    "desktopSize": 132,
    "mobileSize": 72,
    "states": {
      "idle": "idle-bob",
      "walk": "rail-walk",
      "syncing": "typing",
      "success": "hop-star",
      "empty": "sleep",
      "error": "concerned"
    }
  }
}
```

`motion` is `static` or `ambient`. `static` keeps the asset fixed in the lower
right of the chart panel with no animation; `ambient` enables Lite's optional
host-owned reactions. For an ambient pack, the state names are controlled by
Lite: `idle` is the normal dashboard state, `walk` is an occasional rail stroll,
`syncing` is used during sync/connect actions, `success` follows a completed
action, `empty` represents an empty chart, and `error` is a short warning
reaction. A pack maps those states to the six built-in actions (`idle-bob`,
`rail-walk`, `typing`, `hop-star`, `sleep`, `concerned`); it cannot inject its
own animation or event handler. Lite pauses ambient motion when the tab is
hidden and disables motion under `prefers-reduced-motion: reduce`.

## Three-layer token model

Theme CSS contains exactly one `:root` block. It may declare only `--vt-*`
custom properties.

```css
:root {
  /* Primitive */
  --vt-p-bg: #f7f7f4;
  --vt-p-ink: #202124;
  --vt-p-blue: #356ae6;
  --vt-p-gold: #e1b84a;

  /* Semantic */
  --vt-color-background: var(--vt-p-bg);
  --vt-color-surface: #ffffff;
  --vt-color-foreground: var(--vt-p-ink);
  --vt-color-primary: var(--vt-p-blue);
  --vt-color-secondary: var(--vt-p-gold);

  /* Component */
  --vt-body-background: linear-gradient(#f7f7f4, #eeeeea);
  --vt-chart-1: #356ae6;
  --vt-chart-2: #e1b84a;
}
```

Every pack must define these minimum tokens:

- `--vt-color-background`
- `--vt-color-surface`
- `--vt-color-foreground`
- `--vt-color-primary`
- `--vt-color-secondary`
- `--vt-body-background`
- `--vt-chart-1`
- `--vt-chart-2`

The built-in Sunlit Blocks pack at
`src/lite/themes/sunlit-blocks/theme.css` is the complete reference. Optional
stable tokens include:

- Semantic: `--vt-color-scheme`, `--vt-color-muted`, `--vt-color-border`,
  `--vt-color-border-soft`, `--vt-color-primary-strong`, `--vt-color-focus`,
  `--vt-color-info`, `--vt-color-success`, `--vt-color-accent`,
  `--vt-color-warm`, `--vt-color-on-primary`,
  `--vt-color-surface-hover`, `--vt-color-chart-track`, and
  `--vt-color-connect-surface`.
- Components: `--vt-font-sans`, `--vt-panel-radius`, `--vt-button-bg`,
  `--vt-button-bg-hover`, `--vt-button-fg`, `--vt-button-shadow`,
  `--vt-panel-shadow`, `--vt-metric-1-bg` through `--vt-metric-4-bg`, their
  matching foreground/shadow tokens, `--vt-tooltip-*`, and `--vt-toast-*`.
- Chart palette: `--vt-chart-1` through `--vt-chart-8`.

Missing optional tokens use the base Sunlit-compatible fallback.

## Security and failure behavior

Theme packs are presentation data, not plugins. Lite rejects or ignores packs
that use JavaScript, non-token declarations, arbitrary selectors, `@import`,
`url()`, legacy CSS execution hooks, symlinks, directory traversal, invalid
metadata, manifests over 16 KiB, or stylesheets over 128 KiB.

The browser API returns safe manifest metadata only. It never returns install
paths, entry filenames, or mascot asset paths. The selected mascot is served by
`GET /theme-mascot` as a same-origin PNG with a revision ETag; a pack without a
mascot returns 404. Selection requires the page's random CSRF token and a
same-origin request. If the selected pack disappears or becomes invalid, Lite
serves Sunlit Blocks without changing token, cloud, or account data.
