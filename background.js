importScripts("shared.js");

// この拡張が作ったグループの ID。ブラウザを閉じると消えるので、
// 再起動後はタイトルがドメイン名と一致するグループを自分のものとして扱う
const MANAGED_KEY = "managedGroupIds";

async function getManagedIds() {
  const { [MANAGED_KEY]: ids = [] } = await chrome.storage.session.get(MANAGED_KEY);
  return new Set(ids);
}

async function addManagedId(id) {
  const ids = await getManagedIds();
  ids.add(id);
  await chrome.storage.session.set({ [MANAGED_KEY]: [...ids] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// タブをドラッグ中などは "Tabs cannot be edited right now" で失敗するので少し待ってやり直す
async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !String(e?.message).includes("cannot be edited")) throw e;
      await sleep(300);
    }
  }
}

async function organizeWindow(windowId) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return; // ウィンドウがもう閉じている
  }
  if (win.type !== "normal") return;

  const tabs = await chrome.tabs.query({ windowId });
  const groups = await chrome.tabGroups.query({ windowId });
  const managedIds = await getManagedIds();

  const keyed = tabs
    .filter((t) => !t.pinned)
    .map((t) => ({ tab: t, key: groupKey(t.pendingUrl || t.url || "", settings) }));
  const labels = new Set(keyed.filter((k) => k.key).map((k) => labelOf(k.key)));

  // 自分のグループ = 自分で作ったもの、またはタイトルがドメイン名のもの
  const managed = new Map(); // groupId -> title
  for (const g of groups) {
    if (managedIds.has(g.id) || labels.has(g.title)) managed.set(g.id, g.title);
  }

  // ユーザーが自分で作ったグループのタブには触らない
  const NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;
  const eligible = keyed.filter(({ tab }) => tab.groupId === NONE || managed.has(tab.groupId));

  const byKey = new Map();
  for (const item of eligible) {
    if (!item.key) continue;
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item.tab);
  }

  // 1. 自分のグループに入っているが、そこにいるべきでないタブを外す
  const toUngroup = [];
  for (const { tab, key } of eligible) {
    if (!managed.has(tab.groupId)) continue;
    const shouldGroup = key && byKey.get(key).length >= settings.minTabs;
    if (!shouldGroup || managed.get(tab.groupId) !== labelOf(key)) toUngroup.push(tab.id);
  }
  if (toUngroup.length) await withRetry(() => chrome.tabs.ungroup(toUngroup));

  // 2. 同じドメインのタブが minTabs 以上あればグループにまとめる
  for (const [key, keyTabs] of byKey) {
    if (keyTabs.length < settings.minTabs) continue;
    const label = labelOf(key);
    const targetId = [...managed].find(([, title]) => title === label)?.[0];
    const stillThere = targetId !== undefined && keyTabs.some((t) => t.groupId === targetId && !toUngroup.includes(t.id));

    if (stillThere) {
      const moving = keyTabs.filter((t) => t.groupId !== targetId).map((t) => t.id);
      if (moving.length) await withRetry(() => chrome.tabs.group({ groupId: targetId, tabIds: moving }));
    } else {
      const ids = keyTabs.map((t) => t.id);
      const gid = await withRetry(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }));
      await withRetry(() => chrome.tabGroups.update(gid, { title: label, color: colorOf(label) }));
      managed.set(gid, label);
      await addManagedId(gid);
    }
  }

  if (settings.collapseInactive) await collapseOthers(windowId);
}

// 表示中のタブがあるグループだけ開き、ほかの自分のグループは折りたたむ
async function collapseOthers(windowId) {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (!active) return;
  const managedIds = await getManagedIds();
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) {
    if (!managedIds.has(g.id)) continue;
    const collapsed = g.id !== active.groupId;
    if (g.collapsed !== collapsed) {
      await withRetry(() => chrome.tabGroups.update(g.id, { collapsed })).catch(() => {});
    }
  }
}

// 短時間に何度もイベントが来るので、ウィンドウごとにまとめて1回だけ実行する
const timers = new Map();
let queue = Promise.resolve();

function schedule(windowId, delay = 400) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(timers.get(windowId));
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      queue = queue
        .then(() => organizeWindow(windowId))
        .catch((e) => console.warn("organize failed", e));
    }, delay),
  );
}

async function organizeAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const w of wins) schedule(w.id, 0);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url !== undefined || info.pinned !== undefined) schedule(tab.windowId);
});
chrome.tabs.onCreated.addListener((tab) => schedule(tab.windowId));
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (!info.isWindowClosing) schedule(info.windowId);
});
chrome.tabs.onAttached.addListener((tabId, info) => schedule(info.newWindowId));
chrome.tabs.onDetached.addListener((tabId, info) => schedule(info.oldWindowId));

chrome.tabs.onActivated.addListener(async ({ windowId }) => {
  const { enabled, collapseInactive } = await getSettings();
  if (enabled && collapseInactive) {
    queue = queue.then(() => collapseOthers(windowId)).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") organizeAll();
});

chrome.runtime.onInstalled.addListener(organizeAll);
chrome.runtime.onStartup.addListener(organizeAll);

// popup の「今すぐ整理」
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "organizeNow") {
    organizeAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "ungroupAll") {
    ungroupAll().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// 自分のグループをすべて解除する（ユーザーが作ったグループは残す）
async function ungroupAll() {
  const managedIds = await getManagedIds();
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const labels = new Set(
    tabs.map((t) => groupKey(t.url || "", settings)).filter(Boolean).map(labelOf),
  );
  const groups = await chrome.tabGroups.query({});
  const ids = new Set(groups.filter((g) => managedIds.has(g.id) || labels.has(g.title)).map((g) => g.id));
  const targets = tabs.filter((t) => ids.has(t.groupId)).map((t) => t.id);
  if (targets.length) await withRetry(() => chrome.tabs.ungroup(targets));
}
