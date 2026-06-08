// Unit tests for lib/config.js. We stub the chrome.* surface that
// PTHConfig touches, then load the script via vm so it binds against our
// stub instead of a real extension API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeArea() {
  const store = new Map();
  return {
    _store: store,
    async get(key) {
      if (typeof key === "string") {
        return store.has(key) ? { [key]: store.get(key) } : {};
      }
      // object form not used by config.js
      return {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(key) {
      if (Array.isArray(key)) key.forEach(k => store.delete(k));
      else store.delete(key);
    }
  };
}

function loadConfig() {
  const code = fs.readFileSync(path.join(__dirname, "..", "lib", "config.js"), "utf8");
  const sandbox = {
    chrome: {
      storage: {
        local: makeArea(),
        sync: makeArea(),
        onChanged: { addListener: () => {} }
      }
    },
    self: {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { PTHConfig: sandbox.self.PTHConfig, chrome: sandbox.chrome };
}

test("getActiveAreaName defaults to 'local'", async () => {
  const { PTHConfig } = loadConfig();
  assert.equal(await PTHConfig.getActiveAreaName(), "local");
});

test("getActiveAreaName returns 'sync' when pointer is sync", async () => {
  const { PTHConfig, chrome } = loadConfig();
  await chrome.storage.local.set({ storageArea: "sync" });
  assert.equal(await PTHConfig.getActiveAreaName(), "sync");
});

test("getActiveAreaName coerces unknown values to 'local'", async () => {
  const { PTHConfig, chrome } = loadConfig();
  await chrome.storage.local.set({ storageArea: "weird" });
  assert.equal(await PTHConfig.getActiveAreaName(), "local");
});

test("setConfig / getConfig round trip in local", async () => {
  const { PTHConfig } = loadConfig();
  await PTHConfig.setConfig({ enabled: true, globalTerms: ["a"] });
  const c = await PTHConfig.getConfig();
  assert.deepEqual(c, { enabled: true, globalTerms: ["a"] });
});

test("setActiveAreaName migrates config from local to sync", async () => {
  const { PTHConfig, chrome } = loadConfig();
  await PTHConfig.setConfig({ enabled: true, globalTerms: ["x"] });
  const r = await PTHConfig.setActiveAreaName("sync");
  assert.equal(r.ok, true);
  // Old area should no longer have the config.
  assert.equal(chrome.storage.local._store.has("config"), false);
  // New area should.
  assert.deepEqual(chrome.storage.sync._store.get("config"), { enabled: true, globalTerms: ["x"] });
  // Pointer updated.
  assert.equal(chrome.storage.local._store.get("storageArea"), "sync");
});

test("setActiveAreaName is a no-op when already in target area", async () => {
  const { PTHConfig } = loadConfig();
  const r = await PTHConfig.setActiveAreaName("local");
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
});

test("setActiveAreaName surfaces quota / set errors", async () => {
  const { PTHConfig, chrome } = loadConfig();
  await PTHConfig.setConfig({ big: "data" });
  chrome.storage.sync.set = async () => { throw new Error("QUOTA_BYTES exceeded"); };
  const r = await PTHConfig.setActiveAreaName("sync");
  assert.equal(r.ok, false);
  assert.match(r.error, /QUOTA/);
  // On failure, the source area should NOT have been wiped.
  assert.ok(chrome.storage.local._store.has("config"));
});
