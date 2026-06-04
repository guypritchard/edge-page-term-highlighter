// content.js - scans the page for banned terms and shows a banner warning.
(function () {
  if (window.__bannedTermsScanRan) return;
  window.__bannedTermsScanRan = true;

  const BANNER_ID = "__banned-terms-warning-banner__";

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hostMatches(host, pattern) {
    if (!pattern) return false;
    const h = host.toLowerCase();
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    // Support exact host, subdomain match, or substring (e.g. "example.com" matches "www.example.com")
    return h === p || h.endsWith("." + p) || h.includes(p);
  }

  function buildRegex(terms, { caseSensitive, wholeWordOnly }) {
    const cleaned = (terms || [])
      .map((t) => (t == null ? "" : String(t).trim()))
      .filter(Boolean);
    if (cleaned.length === 0) return null;
    const parts = cleaned.map(escapeRegex);
    let source = "(" + parts.join("|") + ")";
    if (wholeWordOnly) {
      // \b doesn't cover unicode well but is good enough for typical word matches.
      source = "\\b" + source + "\\b";
    }
    const flags = "g" + (caseSensitive ? "" : "i");
    try {
      return new RegExp(source, flags);
    } catch (e) {
      console.warn("Banned Terms: bad regex", e);
      return null;
    }
  }

  function getVisibleText() {
    // Grab body innerText; fast enough for most pages.
    return (document.body && document.body.innerText) || "";
  }

  function scan(text, regex) {
    if (!regex) return [];
    const counts = new Map();
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      const key = m[0];
      counts.set(key, (counts.get(key) || 0) + 1);
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    return Array.from(counts.entries()).map(([term, count]) => ({ term, count }));
  }

  function removeBanner() {
    const existing = document.getElementById(BANNER_ID);
    if (existing) existing.remove();
  }

  function showBanner(matches) {
    removeBanner();
    if (!document.body) return;

    const total = matches.reduce((a, b) => a + b.count, 0);
    const summary = matches
      .slice(0, 8)
      .map((m) => `"${m.term}" (${m.count})`)
      .join(", ");
    const more = matches.length > 8 ? `, +${matches.length - 8} more` : "";

    const wrap = document.createElement("div");
    wrap.id = BANNER_ID;
    wrap.setAttribute("role", "alert");
    Object.assign(wrap.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "2147483647",
      background: "#c0392b",
      color: "#fff",
      font: "14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "10px 14px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      gap: "12px"
    });

    const icon = document.createElement("span");
    icon.textContent = "⚠️";
    icon.style.fontWeight = "700";
    icon.style.fontSize = "16px";

    const text = document.createElement("span");
    text.style.flex = "1";
    text.textContent =
      `Banned content warning: ${total} match${total === 1 ? "" : "es"} found - ${summary}${more}`;

    const close = document.createElement("button");
    close.textContent = "Dismiss";
    Object.assign(close.style, {
      background: "rgba(255,255,255,0.15)",
      color: "#fff",
      border: "1px solid rgba(255,255,255,0.6)",
      padding: "4px 10px",
      cursor: "pointer",
      borderRadius: "3px",
      font: "inherit"
    });
    close.addEventListener("click", removeBanner);

    wrap.appendChild(icon);
    wrap.appendChild(text);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
  }

  async function run() {
    let { config } = await chrome.storage.sync.get("config");
    if (!config) return;
    if (!config.enabled) return;

    const host = location.hostname;
    if ((config.disabledHosts || []).some((h) => hostMatches(host, h))) return;

    const terms = [...(config.globalTerms || [])];
    for (const rule of config.siteRules || []) {
      if (rule && hostMatches(host, rule.pattern)) {
        for (const t of rule.terms || []) terms.push(t);
      }
    }

    const regex = buildRegex(terms, {
      caseSensitive: !!config.caseSensitive,
      wholeWordOnly: !!config.wholeWordOnly
    });
    if (!regex) return;

    const text = getVisibleText();
    const matches = scan(text, regex);

    try {
      chrome.runtime.sendMessage({ type: "scanResult", matches });
    } catch (e) {
      // ignore
    }

    if (matches.length > 0) showBanner(matches);
  }

  // Re-scan on storage changes (e.g. user updates config while page is open).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.config) {
      removeBanner();
      run();
    }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    run();
  } else {
    window.addEventListener("DOMContentLoaded", run, { once: true });
  }
})();
