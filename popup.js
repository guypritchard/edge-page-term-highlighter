async function getConfig() { return (await BTWConfig.getConfig()) || {}; }
async function setConfig(config) { await BTWConfig.setConfig(config); }
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

async function askTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return null;
  }
}

// Per-term step counter so repeated clicks cycle through occurrences.
// Keyed by the opaque internal key (e.g. "ci:nasa" or "cs:NASA") to keep
// CI/CS pools separate when the same word appears in both lists.
const stepByKey = new Map();
let currentTabId = null;

function renderMatches(matches, tabId) {
  const wrap = document.getElementById("matchList");
  wrap.textContent = "";
  if (!matches || matches.length === 0) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = "No matches.";
    wrap.appendChild(none);
    return;
  }
  // Sort by count desc, then by term asc for a stable display order.
  matches.sort((a, b) => (b.count - a.count) || a.term.localeCompare(b.term));
  for (const m of matches) {
    const row = document.createElement("div");
    row.className = "match";
    const term = document.createElement("span");
    term.className = "term";
    term.textContent = m.term;
    if (m.cs) {
      const badge = document.createElement("span");
      badge.className = "cs-badge";
      badge.textContent = "Aa";
      badge.title = "Case-sensitive (acronym mode)";
      term.appendChild(badge);
    }
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(m.count);
    const btn = document.createElement("button");
    btn.textContent = "Jump";
    btn.title = "Scroll to the next occurrence on the page";
    btn.addEventListener("click", async () => {
      const key = m.key;
      const next = (stepByKey.get(key) || 0);
      stepByKey.set(key, next + 1);
      const res = await askTab(tabId, { type: "scrollToMatch", key: key, index: next });
      if (res && res.ok) {
        btn.textContent = `${res.index + 1}/${res.count}`;
        setTimeout(() => { btn.textContent = "Jump"; }, 1500);
      }
    });
    row.appendChild(term);
    row.appendChild(count);
    row.appendChild(btn);
    wrap.appendChild(row);
  }
}

// Listen for live scanResult broadcasts from the active tab's content
// script. Re-render the list in place so tab swaps, infinite scroll, and
// DOM removals reflect immediately while the popup is open.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== "scanResult") return;
  if (!sender.tab || sender.tab.id !== currentTabId) return;
  renderMatches(Array.isArray(msg.matches) ? msg.matches : [], currentTabId);
});

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled");
  const hostInfo = document.getElementById("hostInfo");
  const toggleHostBtn = document.getElementById("toggleHost");

  const config = await getConfig();
  enabledEl.checked = !!config.enabled;

  const tab = await currentTab();
  currentTabId = tab && typeof tab.id === "number" ? tab.id : null;
  const host = hostnameOf(tab?.url || "");
  hostInfo.textContent = host ? `Site: ${host}` : "";

  const disabledHosts = config.disabledHosts || [];
  toggleHostBtn.textContent = disabledHosts.includes(host) ? "Enable on this site" : "Disable on this site";

  enabledEl.addEventListener("change", async () => {
    const c = await getConfig();
    c.enabled = enabledEl.checked;
    await setConfig(c);
  });

  toggleHostBtn.addEventListener("click", async () => {
    if (!host) return;
    const c = await getConfig();
    const list = new Set(c.disabledHosts || []);
    if (list.has(host)) list.delete(host); else list.add(host);
    c.disabledHosts = Array.from(list);
    await setConfig(c);
    window.close();
  });

  document.getElementById("rescan").addEventListener("click", async () => {
    if (!tab?.id) return;
    // Try messaging first (cheap). If the content script isn't present, re-inject.
    let res = await askTab(tab.id, { type: "rescanNow" });
    if (!res) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__bannedTermsScanRan = false; } });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    }
    // Refresh popup match list.
    const data = await askTab(tab.id, { type: "getMatches" });
    renderMatches(data?.matches || [], tab.id);
  });

  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  if (tab?.id) {
    const data = await askTab(tab.id, { type: "getMatches" });
    renderMatches(data?.matches || [], tab.id);
  }
});
