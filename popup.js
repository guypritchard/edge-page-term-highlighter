async function getConfig() {
  const { config } = await chrome.storage.sync.get("config");
  return config || {};
}
async function setConfig(config) {
  await chrome.storage.sync.set({ config });
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
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
  const isDisabledHere = disabledHosts.includes(host);
  toggleHostBtn.textContent = isDisabledHere ? "Enable on this site" : "Disable on this site";

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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__bannedTermsScanRan = false; },
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    window.close();
  });

  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
