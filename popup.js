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
const stepByTerm = new Map();

function renderMatches(matches, tabId) {
  const wrap = document.getElementById("matchList");
  wrap.innerHTML = "";
  if (!matches || matches.length === 0) {
    wrap.innerHTML = '<div class="none">No matches.</div>';
    return;
  }
  // Sort by count desc.
  matches.sort((a, b) => b.count - a.count);
  for (const m of matches) {
    const row = document.createElement("div");
    row.className = "match";
    const term = document.createElement("span");
    term.className = "term";
    term.textContent = m.term;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(m.count);
    const btn = document.createElement("button");
    btn.textContent = "Jump";
    btn.title = "Scroll to the next occurrence on the page";
    btn.addEventListener("click", async () => {
      const next = (stepByTerm.get(m.term) || 0);
      stepByTerm.set(m.term, next + 1);
      const res = await askTab(tabId, { type: "scrollToMatch", term: m.term, index: next });
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

document.addEventListener("DOMContentLoaded", async () => {
  const enabledEl = document.getElementById("enabled");
  const hostInfo = document.getElementById("hostInfo");
  const toggleHostBtn = document.getElementById("toggleHost");

  const config = await getConfig();
  enabledEl.checked = !!config.enabled;

  const tab = await currentTab();
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
