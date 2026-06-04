// background.js - service worker.
// Loads lib/config.js (BTWConfig) and lib/matching.js (BTWMatching).
importScripts("lib/config.js", "lib/matching.js");

const DEFAULT_CONFIG = BTWMatching.DEFAULT_CONFIG;

chrome.runtime.onInstalled.addListener(async (details) => {
  // Pin the storage area pointer so the new local-default (introduced in
  // v1.4.1) doesn't silently hide an existing sync config from users
  // upgrading from <= v1.4.0.
  const ptr = await chrome.storage.local.get("storageArea");
  if (!ptr.storageArea) {
    if (details && details.reason === "update") {
      const inSync = await chrome.storage.sync.get("config");
      const inLocal = await chrome.storage.local.get("config");
      if (inSync.config && !inLocal.config) {
        await chrome.storage.local.set({ storageArea: "sync" });
      } else {
        await chrome.storage.local.set({ storageArea: "local" });
      }
    } else {
      // Fresh install: default to local for privacy.
      await chrome.storage.local.set({ storageArea: "local" });
    }
  }

  const existing = await BTWConfig.getConfig();
  if (!existing) {
    await BTWConfig.setConfig(Object.assign({}, DEFAULT_CONFIG));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Hard origin check: only accept messages from our OWN content scripts
  // (sender.id === our extension id, sender.tab present). Extension pages
  // (popup/options) don't update badges, so they shouldn't be reaching here.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== "scanResult") return;
  if (!sender.tab || typeof sender.tab.id !== "number") return;

  const tabId = sender.tab.id;
  // Defensive: matches must be an array of {term, count}. Anything else is
  // treated as zero matches.
  const matches = Array.isArray(msg.matches) ? msg.matches : [];
  const count = matches.length;
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" });
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setTitle({
      tabId,
      title: `Banned Terms: ${count} match${count === 1 ? "" : "es"} on this page`
    });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Banned Terms Warning" });
  }
  sendResponse({ ok: true });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
