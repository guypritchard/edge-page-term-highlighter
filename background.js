// background.js - service worker
// Manages badge state and forwards scan results from content scripts.

const DEFAULT_CONFIG = {
  enabled: true,
  caseSensitive: false,
  wholeWordOnly: true,
  highlightMatches: true,
  globalTerms: [],
  // siteRules: array of { pattern: "example.com" (substring/host match), terms: ["..."] }
  siteRules: [],
  // disabledHosts: array of hostnames to skip entirely
  disabledHosts: []
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get("config");
  if (!existing.config) {
    await chrome.storage.sync.set({ config: DEFAULT_CONFIG });
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

// Clear badge on navigation start.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
