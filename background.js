// background.js - service worker.
// Loads lib/config.js (PTHConfig) and lib/matching.js (PTHMatching).
importScripts("lib/config.js", "lib/matching.js");

const DEFAULT_CONFIG = PTHMatching.DEFAULT_CONFIG;

chrome.runtime.onInstalled.addListener(async () => {
  // Pin storage pointer to local for privacy. v2.0.0 is a clean schema
  // with no upgrade-from-v1 path (sole user).
  const ptr = await chrome.storage.local.get("storageArea");
  if (!ptr.storageArea) {
    await chrome.storage.local.set({ storageArea: "local" });
  }
  const existing = await PTHConfig.getConfig();
  if (!existing) {
    await PTHConfig.setConfig(Object.assign({}, DEFAULT_CONFIG));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Hard origin check: only accept messages from our OWN content scripts.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== "scanResult") return;
  if (!sender.tab || typeof sender.tab.id !== "number") return;

  const tabId = sender.tab.id;
  const matches = Array.isArray(msg.matches) ? msg.matches : [];
  const count = matches.length;
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" });
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setTitle({
      tabId,
      title: `Term matches: ${count} match${count === 1 ? "" : "es"} on this page`
    });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Page Term Highlighter" });
  }
  sendResponse({ ok: true });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
