// background.js - service worker
importScripts("lib/config.js");

const DEFAULT_CONFIG = {
  enabled: true,
  caseSensitive: false,
  wholeWordOnly: true,
  highlightMatches: true,
  globalTerms: [],
  siteRules: [],
  disabledHosts: []
};

chrome.runtime.onInstalled.addListener(async (details) => {
  // Pin the storage area pointer so the new local-default doesn't silently
  // hide an existing sync config from users upgrading from <= v1.4.0.
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
    await BTWConfig.setConfig(DEFAULT_CONFIG);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "scanResult" && sender.tab && typeof sender.tab.id === "number") {
    const count = msg.matches ? msg.matches.length : 0;
    const tabId = sender.tab.id;
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
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
