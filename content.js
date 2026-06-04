// content.js - scans the page for banned terms, highlights them inline, and
// re-scans whenever the page mutates (SPAs, lazy-loaded content, infinite scroll).
(function () {
  if (window.__bannedTermsScanRan) return;
  window.__bannedTermsScanRan = true;

  const BANNER_ID = "__banned-terms-warning-banner__";
  const HIGHLIGHT_CLASS = "__banned-terms-highlight__";
  const MARKER_CLASS = "__banned-terms-marker__";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "CODE", "PRE", "IFRAME", "OBJECT", "EMBED", "SVG", "CANVAS"
  ]);

  // Module state - kept across mutations so we don't repeatedly read storage.
  let state = {
    config: null,
    regex: null,           // regex used for highlighting (no /g state issues per-node)
    terms: [],
    matchCounts: new Map(),// term -> total count seen so far on this page
    observer: null,
    rescanTimer: null,
    pendingNodes: new Set(),
  };

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hostMatches(host, pattern) {
    if (!pattern) return false;
    const h = host.toLowerCase();
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    return h === p || h.endsWith("." + p) || h.includes(p);
  }

  function buildRegex(terms, { caseSensitive, wholeWordOnly }) {
    const cleaned = (terms || [])
      .map((t) => (t == null ? "" : String(t).trim()))
      .filter(Boolean);
    if (cleaned.length === 0) return null;
    // De-duplicate (case-insensitively when matching is case-insensitive) and
    // sort longest-first so alternation prefers the most specific match,
    // e.g. "BAE Systems" wins over "BAE".
    const seen = new Set();
    const unique = [];
    for (const t of cleaned) {
      const key = caseSensitive ? t : t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    unique.sort((a, b) => b.length - a.length);
    const parts = unique.map(escapeRegex);
    let source = "(" + parts.join("|") + ")";
    if (wholeWordOnly) source = "\\b" + source + "\\b";
    const flags = "g" + (caseSensitive ? "" : "i");
    try {
      return new RegExp(source, flags);
    } catch (e) {
      console.warn("Banned Terms: bad regex", e);
      return null;
    }
  }

  function shouldSkipElement(el) {
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.id === BANNER_ID) return true;
      if (el.classList && (el.classList.contains(HIGHLIGHT_CLASS) || el.classList.contains(MARKER_CLASS))) return true;
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }

  function removeBanner() {
    const existing = document.getElementById(BANNER_ID);
    if (existing) existing.remove();
  }

  function removeHighlights() {
    document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.dataset.originalText || el.textContent || ""), el);
      parent.normalize();
    });
    document.querySelectorAll("." + MARKER_CLASS).forEach((el) => el.remove());
  }

  function showBanner() {
    const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
    if (matches.length === 0) {
      removeBanner();
      return;
    }
    removeBanner();
    if (!document.body) return;

    const total = matches.reduce((a, b) => a + b.count, 0);
    const summary = matches.slice(0, 8).map((m) => `"${m.term}" (${m.count})`).join(", ");
    const more = matches.length > 8 ? `, +${matches.length - 8} more` : "";

    const wrap = document.createElement("div");
    wrap.id = BANNER_ID;
    wrap.setAttribute("role", "alert");
    Object.assign(wrap.style, {
      position: "fixed", top: "0", left: "0", right: "0",
      zIndex: "2147483647",
      background: "#c0392b", color: "#fff",
      font: "14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "10px 14px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
      display: "flex", alignItems: "center", gap: "12px"
    });

    const icon = document.createElement("span");
    icon.textContent = "⚠️";
    icon.style.fontWeight = "700";
    icon.style.fontSize = "16px";

    const text = document.createElement("span");
    text.style.flex = "1";
    text.textContent = `Banned content warning: ${total} match${total === 1 ? "" : "es"} found - ${summary}${more}`;

    const close = document.createElement("button");
    close.textContent = "Dismiss";
    Object.assign(close.style, {
      background: "rgba(255,255,255,0.15)", color: "#fff",
      border: "1px solid rgba(255,255,255,0.6)",
      padding: "4px 10px", cursor: "pointer", borderRadius: "3px", font: "inherit"
    });
    close.addEventListener("click", removeBanner);

    wrap.appendChild(icon);
    wrap.appendChild(text);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
  }

  function sendMatches() {
    try {
      const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
      chrome.runtime.sendMessage({ type: "scanResult", matches });
    } catch (e) { /* ignore */ }
  }

  // Walk text nodes under `root` and highlight matches. Returns true if any new matches added.
  function highlightUnder(root) {
    if (!state.regex || !root) return false;
    if (root.nodeType === 1 && shouldSkipElement(root)) return false;

    // If root is a text node, handle directly.
    const textNodes = [];
    if (root.nodeType === 3) {
      if (root.nodeValue && root.nodeValue.trim() && !shouldSkipElement(root.parentNode)) {
        textNodes.push(root);
      }
    } else if (root.nodeType === 1) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipElement(node.parentNode)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) textNodes.push(n);
    } else {
      return false;
    }

    let changed = false;
    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      // Reset regex state per node.
      state.regex.lastIndex = 0;
      if (!state.regex.test(text)) continue;
      state.regex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = state.regex.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));

        const mark = document.createElement("span");
        mark.className = HIGHLIGHT_CLASS;
        mark.dataset.originalText = m[0];
        mark.textContent = m[0];
        Object.assign(mark.style, {
          backgroundColor: "#fff3a3", color: "#000",
          padding: "0 2px", borderRadius: "2px",
          boxShadow: "0 0 0 1px #c0392b inset"
        });
        frag.appendChild(mark);

        if (state.config && state.config.highlightMatches !== false) {
          const marker = document.createElement("span");
          marker.className = MARKER_CLASS;
          marker.textContent = "⚠️";
          marker.title = `Banned term: ${m[0]}`;
          Object.assign(marker.style, {
            display: "inline-block", marginLeft: "2px",
            fontSize: "0.9em", lineHeight: "1",
            verticalAlign: "baseline", textDecoration: "none"
          });
          frag.appendChild(marker);
        }

        state.matchCounts.set(m[0], (state.matchCounts.get(m[0]) || 0) + 1);
        changed = true;

        last = end;
        if (m.index === state.regex.lastIndex) state.regex.lastIndex++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

      if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
    }
    return changed;
  }

  function scheduleRescan(node) {
    if (node) state.pendingNodes.add(node);
    if (state.rescanTimer) return;
    state.rescanTimer = setTimeout(() => {
      state.rescanTimer = null;
      const nodes = Array.from(state.pendingNodes);
      state.pendingNodes.clear();
      let changed = false;
      for (const n of nodes) {
        if (!n.isConnected) continue;
        if (highlightUnder(n)) changed = true;
      }
      if (changed) {
        showBanner();
        sendMatches();
      }
    }, 250);
  }

  function startObserver() {
    if (state.observer) state.observer.disconnect();
    if (!document.body) return;
    state.observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === "childList") {
          mut.addedNodes.forEach((n) => {
            // Avoid reacting to our own injected nodes.
            if (n.nodeType === 1) {
              if (n.id === BANNER_ID) return;
              if (n.classList && (n.classList.contains(HIGHLIGHT_CLASS) || n.classList.contains(MARKER_CLASS))) return;
            }
            scheduleRescan(n);
          });
        } else if (mut.type === "characterData") {
          if (mut.target && !shouldSkipElement(mut.target.parentNode)) {
            scheduleRescan(mut.target);
          }
        }
      }
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function reset() {
    stopObserver();
    removeBanner();
    removeHighlights();
    state.matchCounts = new Map();
    state.pendingNodes.clear();
    if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null; }
  }

  async function loadConfig() {
    const { config } = await chrome.storage.sync.get("config");
    return config || null;
  }

  async function run() {
    reset();
    const config = await loadConfig();
    if (!config || !config.enabled) return;

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

    state.config = config;
    state.terms = terms;
    state.regex = regex;

    // Initial pass over whatever is currently in the DOM.
    if (document.body) highlightUnder(document.body);
    showBanner();
    sendMatches();

    // Watch for future DOM changes (SPA route, lazy-loaded sections, etc.).
    startObserver();
  }

  // Hook SPA navigations (pushState/replaceState don't fire popstate).
  function hookHistory() {
    const fire = () => window.dispatchEvent(new Event("__bannedTermsLocationChange"));
    const wrap = (name) => {
      const orig = history[name];
      if (!orig || orig.__bannedTermsWrapped) return;
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
      wrapped.__bannedTermsWrapped = true;
      history[name] = wrapped;
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", fire);

    let lastUrl = location.href;
    window.addEventListener("__bannedTermsLocationChange", () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Give the SPA a tick to render the new view.
        setTimeout(run, 100);
      }
    });
  }

  // Re-scan on config changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.config) run();
  });

  function start() {
    hookHistory();
    run();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  }

  // Catch the "page kept loading after idle" case.
  window.addEventListener("load", () => {
    // If we already have matches, the observer will pick up further changes.
    // If we don't, do one more pass over the whole body in case content arrived between idle and load.
    if (state.regex && document.body && state.matchCounts.size === 0) {
      if (highlightUnder(document.body)) {
        showBanner();
        sendMatches();
      }
    }
  });
})();
