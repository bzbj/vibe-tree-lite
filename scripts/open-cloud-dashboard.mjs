import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Opens the cloud usage page with the stored session token.
 *
 * The page reads the cloud tree directly, so it needs the token that the Lite
 * app already holds. Pasting a 43-character token by hand is the kind of step
 * that makes a page go unused, and reading it from the same file the app uses
 * keeps the secret out of the clipboard and out of shell history.
 */

const DASHBOARD_URL = process.env.VIBE_TREE_DASHBOARD_URL?.trim() || "https://lab.linjunkai.com/vibe-tree/";
const dataDir = process.env.VIBE_TREE_USER_DATA_DIR?.trim() || defaultDataDir();
const authPath = join(dataDir, "leaderboard-auth.json");

let token;
try {
  token = JSON.parse(readFileSync(authPath, "utf8"))?.token;
} catch {
  // The path is reported rather than the file contents, which are a credential.
  console.error(`没有找到登录凭据：${authPath}`);
  console.error("先在 Vibe Tree Lite 里用 GitHub 登录并完成一次同步，再运行这个命令。");
  process.exit(1);
}
if (typeof token !== "string" || !token.trim()) {
  console.error(`登录凭据里没有 token：${authPath}`);
  process.exit(1);
}

// The token rides in the fragment: fragments are not sent to the web server,
// and the page moves it into localStorage and clears the address bar.
const url = `${DASHBOARD_URL.replace(/\/+$/, "/")}#token=${encodeURIComponent(token.trim())}`;
await open(url);
console.log(`已打开云端用量页：${DASHBOARD_URL}`);
console.log("页面会把令牌保存在本机浏览器；地址栏里的令牌会被立即清除。");

function defaultDataDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Vibe Tree");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Vibe Tree");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Vibe Tree");
}

async function open(target) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false, detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
