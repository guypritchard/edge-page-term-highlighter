// options.js
// Uses shared lib/matching.js (BTWMatching) for DEFAULTS + import sanitisation.
const DEFAULTS = BTWMatching.DEFAULT_CONFIG;

function linesToArr(s) {
  return (s || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function arrToLines(a) {
  return (a || []).join("\n");
}

function renderRule(rule, idx) {
  // Built entirely with createElement / textContent / setAttribute. No
  // innerHTML, no template strings interpolating data.
  const div = document.createElement("div");
  div.className = "rule";
  div.dataset.idx = String(idx);

  const lblPattern = document.createElement("label");
  lblPattern.className = "block";
  lblPattern.textContent = "Hostname pattern";

  const inputPattern = document.createElement("input");
  inputPattern.type = "text";
  inputPattern.className = "rule-pattern";
  inputPattern.placeholder = "example.com";
  inputPattern.maxLength = 253;
  inputPattern.value = (rule && typeof rule.pattern === "string") ? rule.pattern : "";

  const lblTerms = document.createElement("label");
  lblTerms.className = "block";
  lblTerms.textContent = "Banned terms for this site (one per line)";

  const taTerms = document.createElement("textarea");
  taTerms.className = "rule-terms";
  taTerms.placeholder = "term1\nterm2";
  taTerms.value = arrToLines(rule && rule.terms);

  const lblCsTerms = document.createElement("label");
  lblCsTerms.className = "block";
  lblCsTerms.textContent = "Case-sensitive terms for this site (acronym mode)";

  const taCsTerms = document.createElement("textarea");
  taCsTerms.className = "rule-cs-terms";
  taCsTerms.placeholder = "NASA\nAPI";
  taCsTerms.value = arrToLines(rule && rule.csTerms);

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "danger remove-rule";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => div.remove());
  row.appendChild(removeBtn);

  div.appendChild(lblPattern);
  div.appendChild(inputPattern);
  div.appendChild(lblTerms);
  div.appendChild(taTerms);
  div.appendChild(lblCsTerms);
  div.appendChild(taCsTerms);
  div.appendChild(row);
  return div;
}

function collectRules() {
  const out = [];
  document.querySelectorAll("#siteRules .rule").forEach(div => {
    const pattern = div.querySelector(".rule-pattern").value.trim();
    const terms = linesToArr(div.querySelector(".rule-terms").value);
    const csTerms = linesToArr(div.querySelector(".rule-cs-terms").value);
    if (pattern || terms.length || csTerms.length) out.push({ pattern, terms, csTerms });
  });
  return out;
}

async function load() {
  const config = await BTWConfig.getConfig();
  const c = Object.assign({}, DEFAULTS, config || {});
  document.getElementById("enabled").checked = !!c.enabled;
  document.getElementById("caseSensitive").checked = !!c.caseSensitive;
  document.getElementById("wholeWordOnly").checked = !!c.wholeWordOnly;
  document.getElementById("highlightMatches").checked = c.highlightMatches !== false;
  document.getElementById("globalTerms").value = arrToLines(c.globalTerms);
  document.getElementById("globalCsTerms").value = arrToLines(c.globalCsTerms);
  document.getElementById("disabledHosts").value = arrToLines(c.disabledHosts);
  const wrap = document.getElementById("siteRules");
  wrap.textContent = "";
  (c.siteRules || []).forEach((r, i) => wrap.appendChild(renderRule(r, i)));

  const area = await BTWConfig.getActiveAreaName();
  document.getElementById("storageSync").checked = area === "sync";
  document.getElementById("storageLocal").checked = area === "local";
}

async function save() {
  // Run the same sanitiser used by import, so the saved config always
  // conforms to the validated shape (limits enforced, unknown keys dropped).
  const raw = {
    enabled: document.getElementById("enabled").checked,
    caseSensitive: document.getElementById("caseSensitive").checked,
    wholeWordOnly: document.getElementById("wholeWordOnly").checked,
    highlightMatches: document.getElementById("highlightMatches").checked,
    globalTerms: linesToArr(document.getElementById("globalTerms").value),
    globalCsTerms: linesToArr(document.getElementById("globalCsTerms").value),
    disabledHosts: linesToArr(document.getElementById("disabledHosts").value),
    siteRules: collectRules()
  };
  const config = BTWMatching.sanitizeImportedConfig(raw);
  await BTWConfig.setConfig(config);
  flashStatus("Saved.");
}

function flashStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  setTimeout(() => { el.textContent = ""; }, 2400);
}

async function handleStorageChange(target) {
  const res = await BTWConfig.setActiveAreaName(target);
  if (!res.ok) {
    flashStatus("Storage switch failed: " + res.error);
    const area = await BTWConfig.getActiveAreaName();
    document.getElementById("storageSync").checked = area === "sync";
    document.getElementById("storageLocal").checked = area === "local";
    return;
  }
  flashStatus(res.unchanged ? "No change." : `Moved to chrome.storage.${target}.`);
  await load();
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  document.getElementById("addRule").addEventListener("click", () => {
    const wrap = document.getElementById("siteRules");
    wrap.appendChild(renderRule({ pattern: "", terms: [], csTerms: [] }, wrap.children.length));
  });

  document.getElementById("save").addEventListener("click", save);

  document.getElementById("storageSync").addEventListener("change", (e) => {
    if (e.target.checked) handleStorageChange("sync");
  });
  document.getElementById("storageLocal").addEventListener("change", (e) => {
    if (e.target.checked) handleStorageChange("local");
  });

  document.getElementById("export").addEventListener("click", async () => {
    const config = await BTWConfig.getConfig();
    const blob = new Blob([JSON.stringify(config || DEFAULTS, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "banned-terms-config.json"; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      // Hard cap on file size: 1 MiB is plenty for thousands of terms and
      // protects against accidental / malicious huge JSON files.
      if (file.size > 1024 * 1024) throw new Error("file too large (>1 MiB)");
      const text = await file.text();
      const parsed = JSON.parse(text);
      const clean = BTWMatching.sanitizeImportedConfig(parsed);
      await BTWConfig.setConfig(clean);
      await load();
      flashStatus("Imported.");
    } catch (err) {
      flashStatus("Import failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      // Reset the file input so re-selecting the same file fires "change".
      e.target.value = "";
    }
  });
});
