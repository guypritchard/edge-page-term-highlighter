// content.js - scans the page for banned terms using the CSS Custom Highlight
// API where available (no DOM mutation for the colored highlight). Falls back
// to span wrapping on older browsers. Markers (⚠️) are still injected as
// minimal sibling spans when enabled.
(function () {
  if (window.__bannedTermsScanRan) return;
  window.__bannedTermsScanRan = true;

  const MARKER_CLASS = "__btw_mk__";
  const FALLBACK_HIGHLIGHT_CLASS = "__btw_hl__";
  const SHADOW_HOST_ID = "__btw_shadow_host__";
  const HL_NAME = "btw-match";
  const HL_FLASH = "btw-match-flash";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "CODE", "PRE", "IFRAME", "OBJECT", "EMBED", "SVG", "CANVAS"
  ]);

  // Use CSS Custom Highlight API only when the user has chosen no markers
  // (pure-paint, no DOM mutation). When markers are enabled we fall back to
  // span wrapping which gives stable, well-tested marker placement.
  const cssHighlightsAvailable = !!(window.CSS && CSS.highlights && window.Highlight);
  function shouldUseCSSPath() {
    return cssHighlightsAvailable && !!state.config && state.config.highlightMatches === false;
  }

  let highlight = null;
  let flashHighlight = null;
  // Range bookkeeping for CSS-Highlights path: term key (case-folded) -> Range[]
  const rangesByTerm = new Map();
  // For fallback path: term key -> span[]
  const spansByTerm = new Map();

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

  // ---------- regex/utilities ----------
  // Pure helpers live in lib/matching.js (BTWMatching) so they can be unit
  // tested under test/. Only DOM-touching code stays here.
  const { escapeRegex, hostMatches, buildRegex } = BTWMatching;
  function shouldSkipElement(el) {
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.id === SHADOW_HOST_ID) return true;
      if (el.classList && (el.classList.contains(FALLBACK_HIGHLIGHT_CLASS) || el.classList.contains(MARKER_CLASS))) return true;
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }
  function termKeyFor(text) {
    return (state.config && state.config.caseSensitive) ? text : text.toLowerCase();
  }

  // ---------- CSS Highlight setup ----------
  function setupHighlights() {
    if (!shouldUseCSSPath()) return;
    if (highlight) return;
    highlight = new Highlight();
    flashHighlight = new Highlight();
    CSS.highlights.set(HL_NAME, highlight);
    CSS.highlights.set(HL_FLASH, flashHighlight);
    if (!document.getElementById("__btw_hl_style__")) {
      const style = document.createElement("style");
      style.id = "__btw_hl_style__";
      style.textContent = `
        ::highlight(${HL_NAME}) {
          background-color: #fff3a3;
          color: #000;
          text-shadow: none;
        }
        ::highlight(${HL_FLASH}) {
          background-color: #c0392b;
          color: #fff;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // ---------- Shadow DOM banner ----------
  function ensureShadow() {
    if (state.shadowHost && state.shadowRoot) return;
    const host = document.createElement("div");
    host.id = SHADOW_HOST_ID;
    Object.assign(host.style, {
      position: "fixed", top: "0", left: "0", right: "0",
      zIndex: "2147483647", pointerEvents: "none"
    });
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .banner { all: initial; pointer-events: auto; display: flex; align-items: center; gap: 12px;
        background: #c0392b; color: #fff;
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 10px 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
      .icon { font-weight: 700; font-size: 16px; }
      .msg { flex: 1; }
      button { background: rgba(255,255,255,0.15); color: #fff;
        border: 1px solid rgba(255,255,255,0.6);
        padding: 4px 10px; cursor: pointer; border-radius: 3px; font: inherit; }
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
  function showBanner() {
    if (state.bannerDismissed) return;
    const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
    if (matches.length === 0) { removeBanner(); return; }
    ensureShadow(); removeBanner();
    const total = matches.reduce((a, b) => a + b.count, 0);
    const summary = matches.slice(0, 8).map((m) => `"${m.term}" (${m.count})`).join(", ");
    const more = matches.length > 8 ? `, +${matches.length - 8} more` : "";
    const wrap = document.createElement("div");
    wrap.className = "banner"; wrap.setAttribute("role", "alert");
    const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = "\u26A0\uFE0F";
    const text = document.createElement("span"); text.className = "msg";
    text.textContent = `Banned content warning: ${total} match${total === 1 ? "" : "es"} found - ${summary}${more}`;
    const close = document.createElement("button"); close.textContent = "Dismiss";
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

  // ---------- Match processing ----------
  function makeMarker() {
    const marker = document.createElement("span");
    marker.className = MARKER_CLASS;
    marker.textContent = "\u26A0\uFE0F";
    Object.assign(marker.style, {
      display: "inline-block", marginLeft: "2px",
      fontSize: "0.9em", lineHeight: "1", verticalAlign: "baseline"
    });
    return marker;
  }

  function findMatchesInText(text) {
    if (!state.regex) return [];
    state.regex.lastIndex = 0;
    const out = [];
    let m;
    while ((m = state.regex.exec(text)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m.index === state.regex.lastIndex) state.regex.lastIndex++;
    }
    return out;
  }

  function processTextNodeCSS(textNode) {
    // CSS Custom Highlight path: NO DOM mutation. Only used when markers are
    // disabled. See AGENTS.md section 5.
    const matches = findMatchesInText(textNode.nodeValue);
    if (matches.length === 0) return false;
    setupHighlights();
    for (const mt of matches) {
      const key = termKeyFor(mt.text);
      const r = document.createRange();
      r.setStart(textNode, mt.start);
      r.setEnd(textNode, mt.end);
      highlight.add(r);
      if (!rangesByTerm.has(key)) rangesByTerm.set(key, []);
      rangesByTerm.get(key).push(r);
      state.matchCounts.set(key, (state.matchCounts.get(key) || 0) + 1);
    }
    return true;
  }

  function processTextNodeFallback(textNode) {
    const matches = findMatchesInText(textNode.nodeValue);
    if (matches.length === 0) return false;
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const mt of matches) {
      if (mt.start > last) frag.appendChild(document.createTextNode(text.slice(last, mt.start)));
      const key = termKeyFor(mt.text);
      const span = document.createElement("span");
      span.className = FALLBACK_HIGHLIGHT_CLASS;
      span.textContent = mt.text;
      Object.assign(span.style, {
        backgroundColor: "#fff3a3", color: "#000",
        padding: "0 2px", borderRadius: "2px",
        boxShadow: "0 0 0 1px #c0392b inset"
      });
      frag.appendChild(span);
      if (!spansByTerm.has(key)) spansByTerm.set(key, []);
      spansByTerm.get(key).push(span);
      state.matchCounts.set(key, (state.matchCounts.get(key) || 0) + 1);
      if (state.config && state.config.highlightMatches !== false) frag.appendChild(makeMarker());
      last = mt.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
    return true;
  }

  function highlightUnder(root) {
    if (!state.regex || !root) return false;
    if (root.nodeType === 1 && shouldSkipElement(root)) return false;
    const textNodes = [];
    if (root.nodeType === 3) {
      if (root.nodeValue && root.nodeValue.trim() && !shouldSkipElement(root.parentNode)) textNodes.push(root);
    } else if (root.nodeType === 1) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipElement(node.parentNode)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let n; while ((n = walker.nextNode())) textNodes.push(n);
    } else { return false; }

    let changed = false;
    const useCSS = shouldUseCSSPath();
    for (const tn of textNodes) {
      const did = useCSS ? processTextNodeCSS(tn) : processTextNodeFallback(tn);
      if (did) changed = true;
    }
    return changed;
  }

  // ---------- Scroll-to-match ----------
  function flashRange(r) {
    if (!flashHighlight) return;
    flashHighlight.add(r);
    setTimeout(() => { try { flashHighlight.delete(r); } catch (e) {} }, 1500);
  }
  function flashSpan(el) {
    const prev = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 3px #c0392b";
    setTimeout(() => { el.style.boxShadow = prev || "0 0 0 1px #c0392b inset"; }, 1500);
  }

  function scrollToMatch(termKey, index) {
    if (shouldUseCSSPath()) {
      const arr = rangesByTerm.get(termKey);
      if (!arr || arr.length === 0) return { ok: false };
      // Filter still-attached ranges.
      const valid = arr.filter((r) => r.startContainer && r.startContainer.isConnected);
      if (valid.length === 0) return { ok: false };
      const idx = ((index % valid.length) + valid.length) % valid.length;
      const r = valid[idx];
      const rect = r.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 2, behavior: "smooth" });
      flashRange(r);
      return { ok: true, index: idx, count: valid.length };
    } else {
      const arr = spansByTerm.get(termKey);
      if (!arr || arr.length === 0) return { ok: false };
      const valid = arr.filter((el) => el.isConnected);
      if (valid.length === 0) return { ok: false };
      const idx = ((index % valid.length) + valid.length) % valid.length;
      valid[idx].scrollIntoView({ behavior: "smooth", block: "center" });
      flashSpan(valid[idx]);
      return { ok: true, index: idx, count: valid.length };
    }
  }

  // ---------- Mutation observer ----------
  function scheduleRescan(node) {
    if (node) state.pendingNodes.add(node);
    if (state.rescanTimer) return;
    state.rescanTimer = setTimeout(() => {
      state.rescanTimer = null;
      const nodes = Array.from(state.pendingNodes); state.pendingNodes.clear();
      let changed = false;
      for (const n of nodes) { if (!n.isConnected) continue; if (highlightUnder(n)) changed = true; }
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
              if (n.classList && (n.classList.contains(FALLBACK_HIGHLIGHT_CLASS) || n.classList.contains(MARKER_CLASS))) return;
            }
            scheduleRescan(n);
          });
        } else if (mut.type === "characterData") {
          if (mut.target && !shouldSkipElement(mut.target.parentNode)) scheduleRescan(mut.target);
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
  }

  // ---------- Reset / run ----------
  function clearAllHighlights() {
    if (highlight) highlight.clear();
    if (flashHighlight) flashHighlight.clear();
    rangesByTerm.clear();
    // Fallback path: unwrap spans and remove markers.
    document.querySelectorAll("." + FALLBACK_HIGHLIGHT_CLASS).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.textContent || ""), el);
      parent.normalize();
    });
    spansByTerm.clear();
    document.querySelectorAll("." + MARKER_CLASS).forEach((el) => el.remove());
  }

  function reset() {
    stopObserver();
    removeBanner();
    clearAllHighlights();
    state.matchCounts = new Map();
    state.pendingNodes.clear();
    state.bannerDismissed = false;
    if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null; }
  }

  async function run() {
    reset();
    const config = await BTWConfig.getConfig();
    if (!config || !config.enabled) return;
    const host = location.hostname;
    if ((config.disabledHosts || []).some((h) => hostMatches(host, h))) return;
    const terms = [...(config.globalTerms || [])];
    for (const rule of config.siteRules || []) {
      if (rule && hostMatches(host, rule.pattern)) for (const t of rule.terms || []) terms.push(t);
    }
    const regex = buildRegex(terms, {
      caseSensitive: !!config.caseSensitive,
      wholeWordOnly: !!config.wholeWordOnly
    });
    if (!regex) return;
    state.config = config; state.terms = terms; state.regex = regex;
    if (document.body) highlightUnder(document.body);
    showBanner(); sendMatches();
    startObserver();
  }

  // ---------- Messaging ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only accept messages from our own extension (popup / background).
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (!msg || !msg.type) return;
    if (msg.type === "getMatches") {
      const matches = Array.from(state.matchCounts.entries()).map(([term, count]) => ({ term, count }));
      sendResponse({ matches, total: matches.reduce((a, b) => a + b.count, 0) });
      return true;
    }
    if (msg.type === "scrollToMatch") {
      sendResponse(scrollToMatch(msg.term, msg.index || 0));
      return true;
    }
    if (msg.type === "rescanNow") {
      run().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // ---------- SPA route hook ----------
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

  BTWConfig.onConfigChanged(() => run());

  function start() { hookHistory(); run(); }
  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else window.addEventListener("DOMContentLoaded", start, { once: true });

  window.addEventListener("load", () => {
    if (state.regex && document.body && state.matchCounts.size === 0) {
      if (highlightUnder(document.body)) { showBanner(); sendMatches(); }
    }
  });
})();
