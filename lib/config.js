// lib/config.js - shared storage helpers.
// The active storage area pointer ALWAYS lives in chrome.storage.local under
// "storageArea". Its value is either "local" or "sync". When unset, defaults
// to "sync" for backwards compatibility with installs from <= v1.3.0.
//
// This file is loaded in three contexts:
//   - content scripts (via manifest content_scripts)
//   - the background service worker (via importScripts)
//   - extension pages (popup.html / options.html via <script src="lib/config.js">)
//
// It deliberately uses no ES module syntax so it works in all three.

(function (root) {
  const STORAGE_AREA_KEY = "storageArea";
  const CONFIG_KEY = "config";

  async function getActiveAreaName() {
    try {
      const r = await chrome.storage.local.get(STORAGE_AREA_KEY);
      return r[STORAGE_AREA_KEY] === "local" ? "local" : "sync";
    } catch (e) {
      return "sync";
    }
  }

  async function getActiveArea() {
    const name = await getActiveAreaName();
    return chrome.storage[name];
  }

  async function getConfig() {
    const area = await getActiveArea();
    const r = await area.get(CONFIG_KEY);
    return r[CONFIG_KEY] || null;
  }

  async function setConfig(config) {
    const area = await getActiveArea();
    await area.set({ [CONFIG_KEY]: config });
  }

  // Switch the active storage area, migrating the existing config.
  // Returns { ok: true } or { ok: false, error: "..." } so callers can show
  // a quota-exceeded message when copying a big local config back to sync.
  async function setActiveAreaName(target) {
    const desired = target === "local" ? "local" : "sync";
    const currentName = await getActiveAreaName();
    if (currentName === desired) return { ok: true, unchanged: true };
    const from = chrome.storage[currentName];
    const to = chrome.storage[desired];
    const r = await from.get(CONFIG_KEY);
    const config = r[CONFIG_KEY];
    try {
      if (config !== undefined) {
        await to.set({ [CONFIG_KEY]: config });
        await from.remove(CONFIG_KEY);
      }
      await chrome.storage.local.set({ [STORAGE_AREA_KEY]: desired });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  // Subscribe to config changes regardless of which storage area holds it.
  // Callback is invoked with no arguments whenever the active config changes
  // or the storage area pointer flips.
  function onConfigChanged(callback) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local" && changes[STORAGE_AREA_KEY]) {
        callback();
        return;
      }
      if (!changes[CONFIG_KEY]) return;
      const active = await getActiveAreaName();
      if (area === active) callback();
    });
  }

  root.BTWConfig = {
    getActiveAreaName,
    getConfig,
    setConfig,
    setActiveAreaName,
    onConfigChanged,
  };
})(typeof self !== "undefined" ? self : globalThis);
