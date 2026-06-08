// options.js v2.0.0 - profile-based UI.
//
// One profile = { id, name, scope, terms: ["sample phrase", "cs:NASA"] }.
// Scope is one of six kinds; UI shows a dropdown and conditional fields.
// Save runs every profile through PTHMatching.sanitizeImportedConfig so
// the stored shape always conforms (limits + allowlist enforced).
const DEFAULTS = PTHMatching.DEFAULT_CONFIG;
const M = PTHMatching;

// In-memory working copy of profiles. Re-rendered on Add/Remove; field
// values are read from the DOM at save time.
let workingProfiles = [];

function linesToArr(s) {
  return (s || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function arrToLines(a) {
  return (a || []).join("\n");
}

// ---------- scope UI ----------
function scopeFieldsHTML() {
  // Returns the set of conditional field blocks keyed by scope kind.
  // The active one is shown; others hidden via .hidden.
  const wrap = document.createElement("div");
  wrap.className = "scope-fields";
  return wrap;
}

function makeField(labelText, input) {
  const f = document.createElement("div");
  f.className = "field";
  const lbl = document.createElement("label");
  lbl.className = "lbl";
  lbl.textContent = labelText;
  f.appendChild(lbl);
  f.appendChild(input);
  return f;
}

function renderScope(scope) {
  // Returns { wrap, read() -> scope-shaped object, sync() -> refresh visibility }.
  const wrap = document.createElement("div");
  wrap.className = "scope-grid";

  const kindWrap = document.createElement("div");
  const select = document.createElement("select");
  select.className = "scope-kind";
  [
    ["anyUrl", "Any URL"],
    ["wholeSite", "Whole site (host + subdomains)"],
    ["hostOnly", "Just this hostname (no subdomains)"],
    ["pathPrefix", "Section of a site (path prefix)"],
    ["exactUrl", "One exact URL"],
    ["matchPattern", "Advanced: match pattern"]
  ].forEach(([v, label]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label; select.appendChild(o);
  });
  select.value = (scope && M.VALID_SCOPE_KINDS.indexOf(scope.kind) !== -1) ? scope.kind : "wholeSite";
  kindWrap.appendChild(makeField("Where this profile applies", select));
  wrap.appendChild(kindWrap);

  const fields = document.createElement("div");
  fields.className = "scope-fields";
  wrap.appendChild(fields);

  // Inputs we may need - created lazily but referenced from read().
  const host = document.createElement("input");
  host.type = "text"; host.className = "scope-host";
  host.placeholder = "example.com";
  host.maxLength = M.LIMITS.MAX_HOST_LENGTH;
  host.value = (scope && typeof scope.host === "string") ? scope.host : "";

  const path = document.createElement("input");
  path.type = "text"; path.className = "scope-path";
  path.placeholder = "/news";
  path.maxLength = M.LIMITS.MAX_PATH_LENGTH;
  path.value = (scope && typeof scope.path === "string") ? scope.path : "/";

  const scheme = document.createElement("select");
  scheme.className = "scope-scheme";
  [["https", "https"], ["http", "http"]].forEach(([v, t]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = t; scheme.appendChild(o);
  });
  scheme.value = (scope && scope.scheme === "http") ? "http" : "https";

  const pattern = document.createElement("input");
  pattern.type = "text"; pattern.className = "scope-pattern";
  pattern.placeholder = "https://*.example.com/*";
  pattern.maxLength = M.LIMITS.MAX_PATTERN_LENGTH;
  pattern.value = (scope && typeof scope.pattern === "string") ? scope.pattern : "";

  function rebuildFields() {
    fields.textContent = "";
    const kind = select.value;
    if (kind === "anyUrl") {
      const note = document.createElement("div");
      note.style.color = "#6b7280"; note.style.fontSize = "12px";
      note.style.paddingTop = "8px";
      note.textContent = "Profile applies on every page where the extension runs.";
      fields.appendChild(note);
    } else if (kind === "wholeSite" || kind === "hostOnly") {
      fields.appendChild(makeField("Hostname", host));
    } else if (kind === "pathPrefix") {
      fields.appendChild(makeField("Hostname", host));
      fields.appendChild(makeField("Path prefix (must start with /)", path));
    } else if (kind === "exactUrl") {
      fields.appendChild(makeField("Scheme", scheme));
      fields.appendChild(makeField("Hostname", host));
      fields.appendChild(makeField("Path (must start with /)", path));
    } else if (kind === "matchPattern") {
      fields.appendChild(makeField("Match pattern", pattern));
      const help = document.createElement("div");
      help.style.color = "#6b7280"; help.style.fontSize = "12px";
      help.textContent = "Format: scheme://host/path. scheme = *, http, or https. host = *, *.domain, or exact. * wildcards allowed in path.";
      fields.appendChild(help);
    }
  }
  select.addEventListener("change", rebuildFields);
  rebuildFields();

  function read() {
    const kind = select.value;
    if (kind === "anyUrl") return { kind: "anyUrl" };
    if (kind === "wholeSite") return { kind: "wholeSite", host: host.value.trim() };
    if (kind === "hostOnly") return { kind: "hostOnly", host: host.value.trim() };
    if (kind === "pathPrefix") return { kind: "pathPrefix", host: host.value.trim(), path: path.value.trim() };
    if (kind === "exactUrl") return { kind: "exactUrl", scheme: scheme.value, host: host.value.trim(), path: path.value.trim() };
    if (kind === "matchPattern") return { kind: "matchPattern", pattern: pattern.value.trim() };
    return null;
  }
  return { wrap, read };
}

// ---------- profile card ----------
function renderProfile(profile) {
  const card = document.createElement("div");
  card.className = "profile";
  card.dataset.id = profile.id;

  const head = document.createElement("div");
  head.className = "profile-head";

  const name = document.createElement("input");
  name.type = "text"; name.className = "name";
  name.placeholder = "Profile name (e.g. 'Work HR site')";
  name.maxLength = M.LIMITS.MAX_NAME_LENGTH;
  name.value = profile.name || "";
  head.appendChild(name);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button"; removeBtn.className = "danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    workingProfiles = workingProfiles.filter(p => p.id !== profile.id);
    renderProfilesList();
  });
  head.appendChild(removeBtn);
  card.appendChild(head);

  // Scope block.
  const scopeUi = renderScope(profile.scope);
  card.appendChild(scopeUi.wrap);

  // Terms textarea.
  const ta = document.createElement("textarea");
  ta.className = "terms";
  ta.spellcheck = false;
  ta.placeholder = "confidential\ntop secret\ncs:NASA\ncs:API";
  ta.value = arrToLines(profile.terms);

  const termsField = makeField("Terms to highlight (one per line; prefix with cs: for case-sensitive)", ta);
  card.appendChild(termsField);

  const meta = document.createElement("div");
  meta.className = "terms-meta";
  const counts = document.createElement("span");
  const hint = document.createElement("span");
  hint.textContent = 'Tip: "cs:NASA" matches NASA but not nasa.';
  meta.appendChild(counts);
  meta.appendChild(hint);
  termsField.appendChild(meta);

  function updateCounts() {
    const pools = M.splitTermPools(linesToArr(ta.value));
    const total = pools.ci.length + pools.cs.length;
    counts.textContent = total + " term" + (total === 1 ? "" : "s")
      + " (" + pools.cs.length + " case-sensitive)";
  }
  ta.addEventListener("input", updateCounts);
  updateCounts();

  // Attach the readers so collect() can pull live values without a re-render.
  card.__readScope = scopeUi.read;
  card.__readName = () => name.value;
  card.__readTerms = () => linesToArr(ta.value);
  return card;
}

function renderProfilesList() {
  const wrap = document.getElementById("profiles");
  wrap.textContent = "";
  if (workingProfiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No profiles yet. Add one to start scanning pages.";
    wrap.appendChild(empty);
    return;
  }
  for (const p of workingProfiles) wrap.appendChild(renderProfile(p));
}

// ---------- collect & save ----------
function collectProfiles() {
  const out = [];
  document.querySelectorAll("#profiles .profile").forEach((card) => {
    const id = card.dataset.id;
    const name = card.__readName();
    const scope = card.__readScope();
    const terms = card.__readTerms();
    out.push({ id, name, scope, terms });
  });
  return out;
}

async function load() {
  const config = await PTHConfig.getConfig();
  const c = Object.assign({}, DEFAULTS, config || {});
  document.getElementById("enabled").checked = c.enabled !== false;
  document.getElementById("wholeWordOnly").checked = c.wholeWordOnly !== false;
  document.getElementById("highlightMatches").checked = c.highlightMatches !== false;

  workingProfiles = Array.isArray(c.profiles) ? c.profiles.map(p => ({
    id: p.id || M.generateId(),
    name: p.name || "",
    scope: p.scope || { kind: "anyUrl" },
    terms: Array.isArray(p.terms) ? p.terms.slice() : []
  })) : [];

  // Consume a "Add this page" prefill sentinel written by the popup, if any.
  const prefillRes = await chrome.storage.local.get("__btw_prefill");
  if (prefillRes && prefillRes.__btw_prefill) {
    const prefill = prefillRes.__btw_prefill;
    await chrome.storage.local.remove("__btw_prefill");
    if (prefill && typeof prefill === "object" && typeof prefill.host === "string") {
      const newProfile = {
        id: M.generateId(),
        name: prefill.host,
        scope: { kind: "wholeSite", host: prefill.host },
        terms: []
      };
      workingProfiles.push(newProfile);
      // Defer scroll-into-view until after render.
      setTimeout(() => {
        const card = document.querySelector('.profile[data-id="' + newProfile.id + '"]');
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          const ta = card.querySelector("textarea.terms");
          if (ta) ta.focus();
        }
      }, 0);
    }
  }

  renderProfilesList();

  const area = await PTHConfig.getActiveAreaName();
  document.getElementById("storageSync").checked = area === "sync";
  document.getElementById("storageLocal").checked = area === "local";
}

async function save() {
  const raw = {
    schemaVersion: M.SCHEMA_VERSION,
    enabled: document.getElementById("enabled").checked,
    wholeWordOnly: document.getElementById("wholeWordOnly").checked,
    highlightMatches: document.getElementById("highlightMatches").checked,
    profiles: collectProfiles()
  };
  const config = M.sanitizeImportedConfig(raw);
  // Detect profile cards that the sanitiser rejected (e.g. invalid scope).
  const rejected = raw.profiles.length - config.profiles.length;
  await PTHConfig.setConfig(config);
  // Re-load so generated ids appear consistent and rejected cards drop away.
  await load();
  if (rejected > 0) {
    flashStatus("Saved. " + rejected + " profile" + (rejected === 1 ? "" : "s")
      + " dropped (invalid scope).", true);
  } else {
    flashStatus("Saved.");
  }
}

function flashStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
  setTimeout(() => { el.textContent = ""; el.className = "status"; }, 3000);
}

async function handleStorageChange(target) {
  const res = await PTHConfig.setActiveAreaName(target);
  if (!res.ok) {
    flashStatus("Storage switch failed: " + res.error, true);
    const area = await PTHConfig.getActiveAreaName();
    document.getElementById("storageSync").checked = area === "sync";
    document.getElementById("storageLocal").checked = area === "local";
    return;
  }
  flashStatus(res.unchanged ? "No change." : "Moved to chrome.storage." + target + ".");
  await load();
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  document.getElementById("addProfile").addEventListener("click", () => {
    workingProfiles.push({
      id: M.generateId(),
      name: "",
      scope: { kind: "wholeSite", host: "" },
      terms: []
    });
    renderProfilesList();
    // Focus the new card's name field.
    const cards = document.querySelectorAll(".profile");
    const last = cards[cards.length - 1];
    if (last) {
      last.scrollIntoView({ behavior: "smooth", block: "center" });
      const n = last.querySelector("input.name");
      if (n) n.focus();
    }
  });

  document.getElementById("save").addEventListener("click", save);

  document.getElementById("storageSync").addEventListener("change", (e) => {
    if (e.target.checked) handleStorageChange("sync");
  });
  document.getElementById("storageLocal").addEventListener("change", (e) => {
    if (e.target.checked) handleStorageChange("local");
  });

  document.getElementById("export").addEventListener("click", async () => {
    const config = await PTHConfig.getConfig();
    const blob = new Blob([JSON.stringify(config || DEFAULTS, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "page-term-highlighter-config.json"; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("file too large (>1 MiB)");
      const text = await file.text();
      const parsed = JSON.parse(text);
      const clean = M.sanitizeImportedConfig(parsed);
      await PTHConfig.setConfig(clean);
      await load();
      flashStatus("Imported.");
    } catch (err) {
      flashStatus("Import failed: " + (err && err.message ? err.message : String(err)), true);
    } finally {
      e.target.value = "";
    }
  });
});
