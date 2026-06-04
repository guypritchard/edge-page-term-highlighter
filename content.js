// content.js - scans the page for banned terms, highlights them inline, and
// re-scans whenever the page mutates (SPAs, lazy-loaded content, infinite scroll).
(function () {
  if (window.__bannedTermsScanRan) return;
  window.__bannedTermsScanRan = true;

  const HIGHLIGHT_CLASS = "__btw_hl__";
  const MARKER_CLASS = "__btw_mk__";
  const SHADOW_HOST_ID = "__btw_shadow_host__";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "CODE", "PRE", "IFRAME", "OBJECT", "EMBED", "SVG", "CANVAS"
  ]);

  // Term -> short opaque id used in DOM attributes so that page scripts
  // reading our injected spans can't recover the original banned term list.
  const termIds = new Map();    // term -> id
  const idToTerm = new Map();   // id -> term
  let nextId = 1;
  function idForTerm(t) {
    if (termIds.has(t)) return termIds.get(t);
    const id = "t" + (nextId++);
    termIds.set(t, id);
    idToTerm.set(id, t);
    return id;
  }

  // Highlights array kept in document order so the popup can jump through them.
  const highlightOrder = [];    // each entry: { el, term }

  let state = {
    config: null,
    regex: null,
    terms: [],
    matchCounts: new Map(),
    observer: null,
    rescanTimer: null,
    pendingNodes: new Set(),
    shadowHost: null,
    shadowRoot: null,
    bannerDismissed: false,
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
      if (el.id === SHADOW_HOST_ID) return true;
      if (el.classList && (el.classList.contains(HIGHLIGHT_CLASS) || el.classList.contains(MARKER_CLASS))) return true;
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }

  function ensureShadow() {
    if (state.shadowHost && state.shadowRoot) return;
    const host = document.createElement("div");
    host.id = SHADOW_HOST_ID;
    // Style only the host position - the inner UI lives inside a closed shadow root.
    Object.assign(host.style, {
      position: "fixed", top: "0", left: "0", right: "0",
      zIndex: "2147483647", pointerEvents: "none"
    });
    document.documentElement.appendChild(host);
    // closed mode: page scripts cannot access .shadowRoot
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .banner {
        all: initial;
        pointer-events: auto;
        display: flex; align-items: center; gap: 12px;
        background: #c0392b; color: #fff;
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 10px 14px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
      .icon { font-weight: 700; font-size: 16px; }
      .msg { flex: 1; }
      button {
        background: rgba(255,255,255,0.15); color: #fff;
        border: 1px solid rgba(255,255,255,0.6);
        padding: 4px 10px; cursor: pointer; border-radius: 3px;
        font: inherit;
      }
    `;
    root.appendChild(style);
    state.shadowHost = host;
    state.shadowRoot = root;
  }

  function removeBanner() {
    if (state.shadowRoot) {
      const b = state.shadowRoot.querySelector(".banner");
      if (b) b.remove();
    }
  }

  function removeHighlights() {
    document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.textContent || ""), el);
      parent.normalize();
    });
    document.querySelectorAll("." + MARKER_CLASS).forEach((el) => el.remove());
    highlightOrder.length = 0;
  }

  function showBanner() {
    if (state.bannerDismissed) return;
    const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
    if (matches.length === 0) { removeBanner(); return; }
    ensureShadow();
    removeBanner();
    const total = matches.reduce((a, b) => a + b.count, 0);
    const summary = matches.slice(0, 8).map((m) => `"${m.term}" (${m.count})`).join(", ");
    const more = matches.length > 8 ? `, +${matches.length - 8} more` : "";

    const wrap = document.createElement("div");
    wrap.className = "banner";
    wrap.setAttribute("role", "alert");
    const icon = document.createElement("span");
    icon.className = "icon"; icon.textContent = "\u26A0\uFE0F";
    const text = document.createElement("span");
    text.className = "msg";
    text.textContent = `Banned content warning: ${total} match${total === 1 ? "" : "es"} found - ${summary}${more}`;
    const close = document.createElement("button");
    close.textContent = "Dismiss";
    close.addEventListener("click", () => { state.bannerDismissed = true; removeBanner(); });
    wrap.appendChild(icon); wrap.appendChild(text); wrap.appendChild(close);
    state.shadowRoot.appendChild(wrap);
  }

  function sendMatches() {
    try {
      const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
      chrome.runtime.sendMessage({ type: "scanResult", matches });
    } catch (e) { /* ignore */ }
  }

  function highlightUnder(root) {
    if (!state.regex || !root) return false;
    if (root.nodeType === 1 && shouldSkipElement(root)) return false;

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
    } else { return false; }

    let changed = false;
    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
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

        // Bucket by case-insensitive term key for counting/jumping consistency.
        const termKey = (state.config && state.config.caseSensitive) ? m[0] : m[0].toLowerCase();

        const mark = document.createElement("span");
        mark.className = HIGHLIGHT_CLASS;
        mark.setAttribute("data-btw", idForTerm(termKey));
        mark.textContent = m[0];
        Object.assign(mark.style, {
          backgroundColor: "#fff3a3", color: "#000",
          padding: "0 2px", borderRadius: "2px",
          boxShadow: "0 0 0 1px #c0392b inset"
        });
        frag.appendChild(mark);
        highlightOrder.push({ el: mark, term: termKey });

        if (state.config && state.config.highlightMatches !== false) {
          const marker = document.createElement("span");
          marker.className = MARKER_CLASS;
          marker.textContent = "\u26A0\uFE0F";
          // No `title=` and no data attributes carrying the term, to avoid
          // letting page scripts harvest the configured banned word list.
          Object.assign(marker.style, {
            display: "inline-block", marginLeft: "2px",
            fontSize: "0.9em", lineHeight: "1",
            verticalAlign: "baseline"
          });
          frag.appendChild(marker);
        }

        state.matchCounts.set(termKey, (state.matchCounts.get(termKey) || 0) + 1);
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
      if (changed) { showBanner(); sendMatches(); }
    }, 250);
  }

  function startObserver() {
    if (state.observer) state.observer.disconnect();
    if (!document.body) return;
    state.observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === "childList") {
          mut.addedNodes.forEach((n) => {
            if (n.nodeType === 1) {
              if (n.id === SHADOW_HOST_ID) return;
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
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
  }

  function reset() {
    stopObserver();
    removeBanner();
    removeHighlights();
    state.matchCounts = new Map();
    state.pendingNodes.clear();
    state.bannerDismissed = false;
    termIds.clear(); idToTerm.clear(); nextId = 1;
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

    if (document.body) highlightUnder(document.body);
    showBanner();
    sendMatches();
    startObserver();
  }

  // ---- Popup messaging ----
  function flashElement(el) {
    if (!el) return;
    const prev = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 3px #c0392b";
    setTimeout(() => { el.style.boxShadow = prev || "0 0 0 1px #c0392b inset"; }, 1500);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "getMatches") {
      const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
      sendResponse({ matches, total: matches.reduce((a, b) => a + b.count, 0) });
      return true;
    }
    if (msg.type === "scrollToMatch") {
      // term is the lowercased key (or original if caseSensitive). index is which occurrence.
      const term = msg.term;
      const occurrences = highlightOrder.filter((x) => x.term === term);
      if (occurrences.length === 0) { sendResponse({ ok: false }); return true; }
      const idx = ((msg.index || 0) % occurrences.length + occurrences.length) % occurrences.length;
      const target = occurrences[idx].el;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      flashElement(target);
      sendResponse({ ok: true, count: occurrences.length, index: idx });
      return true;
    }
    if (msg.type === "rescanNow") {
      run().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // SPA hooks
  function hookHistory() {
    const fire = () => window.dispatchEvent(new Event("__bannedTermsLocationChange"));
    const wrap = (name) => {
      const orig = history[name];
      if (!orig || orig.__bannedTermsWrapped) return;
      const wrapped = function () { const r = orig.apply(this, arguments); fire(); return r; };
      wrapped.__bannedTermsWrapped = true;
      history[name] = wrapped;
    };
    wrap("pushState"); wrap("replaceState");
    window.addEventListener("popstate", fire);
    let lastUrl = location.href;
    window.addEventListener("__bannedTermsLocationChange", () => {
      if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(run, 100); }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.config) run();
  });

  function start() { hookHistory(); run(); }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  }

  window.addEventListener("load", () => {
    if (state.regex && document.body && state.matchCounts.size === 0) {
      if (highlightUnder(document.body)) { showBanner(); sendMatches(); }
    }
  });
})();
