# Vibe Tree Lite theme packs

Vibe Tree Lite theme packs are local, CSS-token-only packages. They can change
the dashboard's colors, surfaces, shadows, typography, radii, background, metric
cards, and chart palette without changing HTML or JavaScript.

## Package layout

```text
themes/
  my-theme/
    theme.json
    theme.css
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

`theme.json` uses schema version 1:

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
paths or entry filenames. Selection requires the page's random CSRF token and a
same-origin request. If the selected pack disappears or becomes invalid, Lite
serves Sunlit Blocks without changing token, cloud, or account data.
