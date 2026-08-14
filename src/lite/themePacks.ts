import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";

const THEME_SCHEMA_VERSION = 1;
const DEFAULT_THEME_ID = "sunlit-blocks";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_STYLESHEET_BYTES = 128 * 1024;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const REQUIRED_TOKENS = [
  "--vt-color-background",
  "--vt-color-surface",
  "--vt-color-foreground",
  "--vt-color-primary",
  "--vt-color-secondary",
  "--vt-body-background",
  "--vt-chart-1",
  "--vt-chart-2",
] as const;

interface ThemeManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  subtitle: string;
  description?: string;
  author: string;
  version: string;
  colorScheme: "light" | "dark";
  entry: "theme.css";
}

interface LoadedTheme extends ThemeManifest {
  builtin: boolean;
  css: string;
  revision: string;
}

interface ThemeState {
  schemaVersion: 1;
  activeThemeId: string;
}

export interface PublicThemePack {
  id: string;
  name: string;
  subtitle: string;
  description?: string;
  author: string;
  version: string;
  colorScheme: "light" | "dark";
  builtin: boolean;
  revision: string;
}

export interface ThemeCatalog {
  activeId: string;
  active: PublicThemePack;
  themes: PublicThemePack[];
  ignoredCount: number;
}

interface LiteThemePacksOptions {
  bundledRoot: string;
  userRoot: string;
  statePath: string;
  readJson: <T>(path: string) => T | undefined;
  writeJsonAtomic: (path: string, value: unknown) => void;
}

export class LiteThemePacks {
  private activeThemeId: string;

  constructor(private readonly options: LiteThemePacksOptions) {
    mkdirSync(options.userRoot, { recursive: true });
    const state = options.readJson<ThemeState>(options.statePath);
    this.activeThemeId = state?.schemaVersion === THEME_SCHEMA_VERSION && validThemeId(state.activeThemeId)
      ? state.activeThemeId
      : DEFAULT_THEME_ID;
  }

  catalog(): ThemeCatalog {
    const scan = this.scan();
    const active = scan.themes.get(this.activeThemeId) ?? scan.themes.get(DEFAULT_THEME_ID) ?? firstTheme(scan.themes);
    if (!active) throw new Error("Vibe Tree Lite 没有可用的主题包。");
    return {
      activeId: active.id,
      active: publicTheme(active),
      themes: [...scan.themes.values()].map(publicTheme),
      ignoredCount: scan.ignoredCount,
    };
  }

  select(themeId: unknown): ThemeCatalog | undefined {
    if (typeof themeId !== "string" || !validThemeId(themeId)) return undefined;
    const scan = this.scan();
    if (!scan.themes.has(themeId)) return undefined;
    this.activeThemeId = themeId;
    this.options.writeJsonAtomic(this.options.statePath, {
      schemaVersion: THEME_SCHEMA_VERSION,
      activeThemeId: themeId,
    } satisfies ThemeState);
    return this.catalog();
  }

  stylesheet() {
    const scan = this.scan();
    const active = scan.themes.get(this.activeThemeId) ?? scan.themes.get(DEFAULT_THEME_ID) ?? firstTheme(scan.themes);
    if (!active) throw new Error("Vibe Tree Lite 没有可用的主题样式。");
    return {
      id: active.id,
      revision: active.revision,
      css: `/* Vibe Tree Lite theme: ${active.id} @ ${active.version} */\n${active.css.trim()}\n`,
    };
  }

  private scan() {
    const themes = new Map<string, LoadedTheme>();
    let ignoredCount = 0;
    const addRoot = (root: string, builtin: boolean) => {
      const loaded = loadThemeRoot(root, builtin);
      ignoredCount += loaded.ignoredCount;
      for (const theme of loaded.themes) {
        if (themes.has(theme.id)) {
          ignoredCount += 1;
          continue;
        }
        themes.set(theme.id, theme);
      }
    };
    addRoot(this.options.bundledRoot, true);
    addRoot(this.options.userRoot, false);
    return { themes, ignoredCount };
  }
}

function loadThemeRoot(root: string, builtin: boolean) {
  const themes: LoadedTheme[] = [];
  let ignoredCount = 0;
  if (!existsSync(root)) return { themes, ignoredCount };
  let rootPath: string;
  try {
    rootPath = realpathSync(root);
  } catch {
    return { themes, ignoredCount: 1 };
  }
  for (const directoryName of safeDirectoryNames(root)) {
    try {
      if (!validThemeId(directoryName)) throw new Error("invalid theme directory id");
      const directory = join(root, directoryName);
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("theme directory must be real");
      const manifestPath = join(directory, "theme.json");
      const manifest = parseManifest(readBoundedFile(manifestPath, MAX_MANIFEST_BYTES), directoryName);
      const cssPath = join(directory, manifest.entry);
      assertContained(rootPath, cssPath);
      const css = readBoundedFile(cssPath, MAX_STYLESHEET_BYTES);
      validateThemeCss(css);
      const revision = createHash("sha256").update(JSON.stringify(manifest)).update("\0").update(css).digest("hex").slice(0, 16);
      themes.push({ ...manifest, builtin, css, revision });
    } catch {
      ignoredCount += 1;
    }
  }
  themes.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { themes, ignoredCount };
}

function safeDirectoryNames(root: string) {
  try {
    return readdirSync(root).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readBoundedFile(path: string, maxBytes: number) {
  const fileStat = lstatSync(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxBytes) throw new Error("invalid theme file");
  return readFileSync(path, "utf8");
}

function assertContained(rootPath: string, path: string) {
  const target = realpathSync(path);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) throw new Error("theme path escapes root");
}

function parseManifest(text: string, directoryName: string): ThemeManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new Error("theme manifest too large");
  const value = JSON.parse(text) as Partial<ThemeManifest>;
  if (value.schemaVersion !== THEME_SCHEMA_VERSION) throw new Error("unsupported theme schema");
  if (!validThemeId(value.id) || value.id !== directoryName) throw new Error("theme id mismatch");
  if (!validText(value.name, 48) || !validText(value.subtitle, 64)) throw new Error("invalid theme label");
  if (value.description !== undefined && !validText(value.description, 180)) throw new Error("invalid theme description");
  if (!validText(value.author, 80) || typeof value.version !== "string" || !SAFE_VERSION.test(value.version)) {
    throw new Error("invalid theme provenance");
  }
  if (value.colorScheme !== "light" && value.colorScheme !== "dark") throw new Error("invalid color scheme");
  if (value.entry !== "theme.css") throw new Error("theme entry must be theme.css");
  return value as ThemeManifest;
}

export function validateThemeCss(css: string) {
  if (Buffer.byteLength(css, "utf8") > MAX_STYLESHEET_BYTES) throw new Error("theme stylesheet too large");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (/\\|\@import|url\s*\(|(?:https?|file|data)\s*:|(?:-webkit-)?image-set\s*\(|expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i.test(stripped)) {
    throw new Error("theme stylesheet contains unsupported resources or execution hooks");
  }
  const root = /^:root\s*\{([\s\S]*)\}\s*$/.exec(stripped);
  if (!root) throw new Error("theme stylesheet must contain one :root token block");
  const tokens = new Set<string>();
  for (const rawDeclaration of root[1].split(";")) {
    const declaration = rawDeclaration.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(":");
    if (separator <= 0) throw new Error("invalid theme token declaration");
    const property = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (!/^--vt-[a-z0-9-]+$/.test(property) || !value || /[{}]/.test(value)) throw new Error("invalid theme token");
    tokens.add(property);
  }
  for (const required of REQUIRED_TOKENS) {
    if (!tokens.has(required)) throw new Error(`theme is missing ${required}`);
  }
}

function validThemeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function publicTheme(theme: LoadedTheme): PublicThemePack {
  return {
    id: theme.id,
    name: theme.name,
    subtitle: theme.subtitle,
    description: theme.description,
    author: theme.author,
    version: theme.version,
    colorScheme: theme.colorScheme,
    builtin: theme.builtin,
    revision: theme.revision,
  };
}

function firstTheme(themes: Map<string, LoadedTheme>) {
  return themes.values().next().value as LoadedTheme | undefined;
}
