const DEFAULTS = {
  enabled: true,
  caseSensitive: false,
  wholeWordOnly: true,
  highlightMatches: true,
  globalTerms: [],
  siteRules: [],
  disabledHosts: []
};

function linesToArr(s) {
  return (s || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function arrToLines(a) {
  return (a || []).join("\n");
}

function renderRule(rule, idx) {
  const div = document.createElement("div");
  div.className = "rule";
  div.dataset.idx = String(idx);
  div.innerHTML = `
    <label class="block">Hostname pattern</label>
    <input type="text" class="rule-pattern" placeholder="example.com" />
    <label class="block">Banned terms for this site (one per line)</label>
    <textarea class="rule-terms" placeholder="term1&#10;term2"></textarea>
    <div class="row" style="margin-top:8px">
      <button type="button" class="danger remove-rule">Remove</button>
    </div>
  `;
  div.querySelector(".rule-pattern").value = rule.pattern || "";
  div.querySelector(".rule-terms").value = arrToLines(rule.terms);
  div.querySelector(".remove-rule").addEventListener("click", () => {
    div.remove();
  });
  return div;
}

function collectRules() {
  const out = [];
  document.querySelectorAll("#siteRules .rule").forEach(div => {
    const pattern = div.querySelector(".rule-pattern").value.trim();
    const terms = linesToArr(div.querySelector(".rule-terms").value);
    if (pattern || terms.length) out.push({ pattern, terms });
  });
  return out;
}

async function load() {
  const { config } = await chrome.storage.sync.get("config");
  const c = Object.assign({}, DEFAULTS, config || {});
  document.getElementById("enabled").checked = !!c.enabled;
  document.getElementById("caseSensitive").checked = !!c.caseSensitive;
  document.getElementById("wholeWordOnly").checked = !!c.wholeWordOnly;
  document.getElementById("highlightMatches").checked = c.highlightMatches !== false;
  document.getElementById("globalTerms").value = arrToLines(c.globalTerms);
  document.getElementById("disabledHosts").value = arrToLines(c.disabledHosts);
  const wrap = document.getElementById("siteRules");
  wrap.innerHTML = "";
  (c.siteRules || []).forEach((r, i) => wrap.appendChild(renderRule(r, i)));
}

async function save() {
  const config = {
    enabled: document.getElementById("enabled").checked,
    caseSensitive: document.getElementById("caseSensitive").checked,
    wholeWordOnly: document.getElementById("wholeWordOnly").checked,
    highlightMatches: document.getElementById("highlightMatches").checked,
    globalTerms: linesToArr(document.getElementById("globalTerms").value),
    disabledHosts: linesToArr(document.getElementById("disabledHosts").value),
    siteRules: collectRules()
  };
  await chrome.storage.sync.set({ config });
  flashStatus("Saved.");
}

function flashStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  setTimeout(() => { el.textContent = ""; }, 1800);
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  document.getElementById("addRule").addEventListener("click", () => {
    const wrap = document.getElementById("siteRules");
    wrap.appendChild(renderRule({ pattern: "", terms: [] }, wrap.children.length));
  });

  document.getElementById("save").addEventListener("click", save);

  document.getElementById("export").addEventListener("click", async () => {
    const { config } = await chrome.storage.sync.get("config");
    const blob = new Blob([JSON.stringify(config || DEFAULTS, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "banned-terms-config.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const merged = Object.assign({}, DEFAULTS, parsed);
      await chrome.storage.sync.set({ config: merged });
      await load();
      flashStatus("Imported.");
    } catch (err) {
      flashStatus("Import failed: " + err.message);
    }
  });
});
