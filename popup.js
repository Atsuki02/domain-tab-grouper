const $ = (id) => document.getElementById(id);

async function init() {
  const s = await getSettings();
  $("enabled").checked = s.enabled;
  $("minTabs").value = s.minTabs;
  $("mergeSubdomains").checked = s.mergeSubdomains;
  $("collapseInactive").checked = s.collapseInactive;
  $("exclude").value = s.exclude.join("\n");
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

for (const id of ["enabled", "mergeSubdomains", "collapseInactive"]) {
  $(id).addEventListener("change", (e) => save({ [id]: e.target.checked }));
}

$("minTabs").addEventListener("change", (e) => {
  const n = Math.min(20, Math.max(1, parseInt(e.target.value, 10) || DEFAULTS.minTabs));
  e.target.value = n;
  save({ minTabs: n });
});

$("exclude").addEventListener("change", (e) => {
  const list = e.target.value
    .split("\n")
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  save({ exclude: list });
});

$("organize").addEventListener("click", () => chrome.runtime.sendMessage({ type: "organizeNow" }));

// 自動でまとめる設定がオンのままだと、次にタブを開いたときにまたまとまるのでオフにする
$("ungroup").addEventListener("click", async () => {
  $("enabled").checked = false;
  await chrome.storage.sync.set({ enabled: false });
  chrome.runtime.sendMessage({ type: "ungroupAll" });
});

init();
