// popup.js v2.0.0 - profile-based, no per-host disable.
async function getConfig() { return (await PTHConfig.getConfig()) || {}; }
async function setConfig(config) { await PTHConfig.setConfig(config); }
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function parsedOf(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname.toLowerCase(),
      scheme: u.protocol.replace(/:$/, "").toLowerCase(),
      path: u.pathname || "/"
    };
  } catch { return null; }
}

async function askTab(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (e) { return null; }
}

const stepByKey = new Map();
let currentTabId = null;

function renderMatches(matches, tabId) {
  const wrap = document.getElementById("matchList");
  wrap.textContent = "";
  if (!matches || matches.length === 0) {
    const none = document.createElement("div");
    none.className = "none"; none.textContent = "No matches.";
    wrap.appendChild(none); return;
  }
  matches.sort((a, b) => (b.count - a.count) || a.term.localeCompare(b.term));
  for (const m of matches) {
    const row = document.createElement("div"); row.className = "match";
    const term = document.createElement("span"); term.className = "term"; term.textContent = m.term;
    if (m.cs) {
      const badge = document.createElement("span");
      badge.className = "cs-badge"; badge.textContent = "Aa";
      badge.title = "Case-sensitive";
      term.appendChild(badge);
    }
    const count = document.createElement("span"); count.className = "count"; count.textContent = String(m.count);
    const btn = document.createElement("button"); btn.textContent = "Jump";
    btn.title = "Scroll to the next occurrence on the page";
    btn.addEventListener("click", async () => {
      const key = m.key;
      const next = stepByKey.get(key) || 0;
      stepByKey.set(key, next + 1);
      const res = await askTab(tabId, { type: "scrollToMatch", key, index: next });
      if (res && res.ok) {
        btn.textContent = (res.index + 1) + "/" + res.count;
        setTimeout(() => { btn.textContent = "Jump"; }, 1500);
      }
    });
    row.appendChild(term); row.appendChild(count); row.appendChild(btn);
    wrap.appendChild(row);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== "scanResult") return;
  if (!sender.tab || sender.tab.id !== currentTabId) return;
  renderMatches(Array.isArray(msg.matches) ? msg.matches : [], currentTabId);
});

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled");
  const hostInfo = document.getElementById("hostInfo");
  const addPageBtn = document.getElementById("addPage");

  const config = await getConfig();
  enabledEl.checked = config.enabled !== false;

  const tab = await currentTab();
  currentTabId = tab && typeof tab.id === "number" ? tab.id : null;
  const parsed = parsedOf(tab && tab.url);
  hostInfo.textContent = parsed ? "Site: " + parsed.host : "";

  enabledEl.addEventListener("change", async () => {
    const c = await getConfig();
    c.enabled = enabledEl.checked;
    await setConfig(c);
  });

  addPageBtn.addEventListener("click", async () => {
    if (!parsed) return;
    // Hand off to options page via a one-shot prefill sentinel in
    // chrome.storage.local. Options reads + deletes it on load and
    // creates a new profile scoped to this site.
    await chrome.storage.local.set({
      __btw_prefill: { host: parsed.host, scheme: parsed.scheme, path: parsed.path }
    });
    chrome.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById("rescan").addEventListener("click", async () => {
    if (!tab || !tab.id) return;
    let res = await askTab(tab.id, { type: "rescanNow" });
    if (!res) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__pthScanRan = false; } });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    }
    const data = await askTab(tab.id, { type: "getMatches" });
    renderMatches((data && data.matches) || [], tab.id);
  });

  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  if (tab && tab.id) {
    const data = await askTab(tab.id, { type: "getMatches" });
    renderMatches((data && data.matches) || [], tab.id);
  }
});
