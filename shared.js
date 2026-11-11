// background と popup で共有する設定値とドメイン処理
const DEFAULTS = {
  enabled: true,
  minTabs: 2, // この数以上そろったらグループにする
  mergeSubdomains: false, // true なら mail.google.com と docs.google.com を同じグループにする
  collapseInactive: false, // 見ていないグループを自動で折りたたむ
  exclude: [], // グループにしないドメイン（サブドメインも含む）
};

// 2階層のパブリックサフィックス（co.jp など）。完全な一覧ではなく、よく使うものだけ
const SECOND_LEVEL = new Set([
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "gr.jp", "ed.jp", "lg.jp",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "co.nz", "com.br", "com.cn", "com.tw",
  "co.kr", "com.sg", "com.hk", "co.in",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "notion.site",
]);

const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function isIp(host) {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

// ホスト名から「サフィックスの直前のラベル」までを返す: mail.google.com → google.com
function registrableDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  const n = SECOND_LEVEL.has(lastTwo) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function suffixOf(host) {
  const parts = host.split(".");
  if (parts.length < 2) return "";
  const lastTwo = parts.slice(-2).join(".");
  return parts.length >= 3 && SECOND_LEVEL.has(lastTwo) ? lastTwo : parts[parts.length - 1];
}

// タブをまとめるキー。対象外のタブは null
function groupKey(url, settings) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (!host) return null;
  if (isExcluded(host, settings.exclude)) return null;
  if (isIp(host) || !host.includes(".")) return host;
  return settings.mergeSubdomains ? registrableDomain(host) : host;
}

function isExcluded(host, exclude) {
  return exclude.some((d) => host === d || host.endsWith("." + d));
}

// グループのタイトル: github.com → github, mail.google.com → mail.google
function labelOf(key) {
  if (isIp(key) || !key.includes(".")) return key;
  const suffix = suffixOf(key);
  if (!suffix || suffix === key) return key;
  return key.slice(0, -(suffix.length + 1));
}

// 同じドメインはいつも同じ色になるようにする
function colorOf(label) {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
