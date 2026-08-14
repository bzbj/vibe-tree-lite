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
const MASCOT_THEME_SCHEMA_VERSION = 2;
const DEFAULT_THEME_ID = "sunlit-blocks";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_STYLESHEET_BYTES = 128 * 1024;
const MAX_MASCOT_BYTES = 2 * 1024 * 1024;
const MAX_MASCOT_DIMENSION = 2048;
const MAX_MASCOT_PIXELS = 4 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const SAFE_MASCOT_ASSET = /^assets\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.png$/;
const MASCOT_ACTIONS = ["idle-bob", "rail-walk", "typing", "hop-star", "sleep", "concerned"] as const;
const MASCOT_SLOTS = ["chart-rail"] as const;
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

type MascotAction = typeof MASCOT_ACTIONS[number];
type MascotSlot = typeof MASCOT_SLOTS[number];
type MascotState = "idle" | "walk" | "syncing" | "success" | "empty" | "error";

interface MascotManifest {
  asset: string;
  slot: MascotSlot;
  desktopSize: number;
  mobileSize: number;
  states: Record<MascotState, MascotAction>;
}

interface ThemeManifest {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  subtitle: string;
  description?: string;
  author: string;
  version: string;
  colorScheme: "light" | "dark";
  entry: "theme.css";
  mascot?: MascotManifest;
}

interface LoadedTheme extends ThemeManifest {
  builtin: boolean;
  css: string;
  revision: string;
  mascotAsset?: Buffer;
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
  mascot?: {
    slot: MascotSlot;
    desktopSize: number;
    mobileSize: number;
    states: Record<MascotState, MascotAction>;
  };
}

export interface ThemeCatalog {
  activeId: string;
  active: PublicThemePack;
  themes: PublicThemePack[];
  ignoredCount: number;
}

export interface ThemeMascotAsset {
  id: string;
  revision: string;
  contentType: "image/png";
  body: Buffer;
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

  mascot() {
    const scan = this.scan();
    const active = scan.themes.get(this.activeThemeId) ?? scan.themes.get(DEFAULT_THEME_ID) ?? firstTheme(scan.themes);
    if (!active?.mascot || !active.mascotAsset) return undefined;
    return {
      id: active.id,
      revision: active.revision,
      contentType: "image/png",
      body: active.mascotAsset,
    } satisfies ThemeMascotAsset;
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
      const mascotAsset = manifest.mascot
        ? readMascotAsset(rootPath, directory, manifest.mascot)
        : undefined;
      const revision = createHash("sha256").update(JSON.stringify(manifest)).update("\0").update(css).update("\0").update(mascotAsset ?? Buffer.alloc(0)).digest("hex").slice(0, 16);
      themes.push({ ...manifest, builtin, css, revision, mascotAsset });
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

function readMascotAsset(rootPath: string, directory: string, mascot: MascotManifest) {
  const assetPath = join(directory, mascot.asset);
  assertContained(rootPath, assetPath);
  const fileStat = lstatSync(assetPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_MASCOT_BYTES) throw new Error("invalid mascot asset");
  const body = readFileSync(assetPath);
  validatePngAsset(body);
  return body;
}

function assertContained(rootPath: string, path: string) {
  const target = realpathSync(path);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) throw new Error("theme path escapes root");
}

function parseManifest(text: string, directoryName: string): ThemeManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new Error("theme manifest too large");
  const value = JSON.parse(text) as Partial<ThemeManifest>;
  if (value.schemaVersion !== THEME_SCHEMA_VERSION && value.schemaVersion !== MASCOT_THEME_SCHEMA_VERSION) throw new Error("unsupported theme schema");
  if (!validThemeId(value.id) || value.id !== directoryName) throw new Error("theme id mismatch");
  if (!validText(value.name, 48) || !validText(value.subtitle, 64)) throw new Error("invalid theme label");
  if (value.description !== undefined && !validText(value.description, 180)) throw new Error("invalid theme description");
  if (!validText(value.author, 80) || typeof value.version !== "string" || !SAFE_VERSION.test(value.version)) {
    throw new Error("invalid theme provenance");
  }
  if (value.colorScheme !== "light" && value.colorScheme !== "dark") throw new Error("invalid color scheme");
  if (value.entry !== "theme.css") throw new Error("theme entry must be theme.css");
  if (value.schemaVersion === MASCOT_THEME_SCHEMA_VERSION) {
    if (!value.mascot || typeof value.mascot !== "object") throw new Error("mascot configuration required");
    value.mascot = parseMascot(value.mascot);
  } else if (value.mascot !== undefined) {
    throw new Error("mascot requires schema 2");
  }
  return value as ThemeManifest;
}

function parseMascot(value: unknown): MascotManifest {
  if (!value || typeof value !== "object") throw new Error("invalid mascot configuration");
  const mascot = value as Partial<MascotManifest>;
  if (typeof mascot.asset !== "string" || !SAFE_MASCOT_ASSET.test(mascot.asset)) throw new Error("invalid mascot asset path");
  if (!MASCOT_SLOTS.includes(mascot.slot as MascotSlot)) throw new Error("invalid mascot slot");
  if (!validMascotSize(mascot.desktopSize) || !validMascotSize(mascot.mobileSize)) throw new Error("invalid mascot size");
  if (!mascot.states || typeof mascot.states !== "object") throw new Error("invalid mascot states");
  const states = mascot.states as Partial<Record<MascotState, unknown>>;
  const requiredStates: MascotState[] = ["idle", "walk", "syncing", "success", "empty", "error"];
  for (const state of requiredStates) {
    if (!MASCOT_ACTIONS.includes(states[state] as MascotAction)) throw new Error(`invalid mascot action for ${state}`);
  }
  return {
    asset: mascot.asset,
    slot: mascot.slot as MascotSlot,
    desktopSize: mascot.desktopSize as number,
    mobileSize: mascot.mobileSize as number,
    states: Object.fromEntries(requiredStates.map((state) => [state, states[state]])) as Record<MascotState, MascotAction>,
  };
}

function validMascotSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 48 && value <= 180;
}

function validatePngAsset(body: Buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (body.length < 33 || !body.subarray(0, 8).equals(signature) || body.toString("ascii", 12, 16) !== "IHDR") throw new Error("mascot asset must be PNG");
  const width = body.readUInt32BE(16);
  const height = body.readUInt32BE(20);
  const colorType = body[25];
  if (!width || !height || width > MAX_MASCOT_DIMENSION || height > MAX_MASCOT_DIMENSION || width * height > MAX_MASCOT_PIXELS) throw new Error("mascot asset dimensions too large");
  if (colorType !== 4 && colorType !== 6) throw new Error("mascot PNG must include alpha");
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
    mascot: theme.mascot ? {
      slot: theme.mascot.slot,
      desktopSize: theme.mascot.desktopSize,
      mobileSize: theme.mascot.mobileSize,
      states: theme.mascot.states,
    } : undefined,
  };
}

function firstTheme(themes: Map<string, LoadedTheme>) {
  return themes.values().next().value as LoadedTheme | undefined;
}
