// lib/matching.js - pure helpers shared by content.js, background.js, and
// options.js. NO chrome.* API calls here. NO DOM access. This file is the
// security/regex/validation core, and is unit-tested under test/.
//
// Loaded as a classic script in extension contexts (no ES modules) AND
// required as a CommonJS module by the Node test runner (see bottom of file).
(function (root) {
  "use strict";

  // Single source of truth for the default config shape. background.js seeds
  // first-install storage with this; options.js back-fills the form with it;
  // sanitizeImportedConfig() uses it to reject unknown / malformed fields.
  //
  // v1.6.0 added globalCsTerms (top-level) and csTerms (per-rule) - terms in
  // those lists are ALWAYS matched case-sensitively, regardless of the
  // global `caseSensitive` flag. Useful for acronyms (NASA, API, BAE).
  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    caseSensitive: false,
    wholeWordOnly: true,
    highlightMatches: true,
    globalTerms: [],
    globalCsTerms: [],
    siteRules: [],
    disabledHosts: []
  });

  // Hard caps. Anything beyond these is almost certainly a mistake or an
  // attempt to DoS the regex engine / storage quota. Reject on import.
  // MAX_TERMS is per list (CI and CS pools cap independently); the 1 MiB
  // import file cap in options.js bounds total absolute size.
  const LIMITS = Object.freeze({
    MAX_TERM_LENGTH: 200,
    MAX_TERMS: 5000,
    MAX_SITE_RULES: 500,
    MAX_DISABLED_HOSTS: 500,
    MAX_HOST_LENGTH: 253 // RFC 1035
  });

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hostMatches(host, pattern) {
    if (!pattern) return false;
    const h = String(host || "").toLowerCase();
    const p = String(pattern).trim().toLowerCase();
    if (!p) return false;
    // Exact, or strict subdomain match. The previous .includes() fallback
    // was a footgun: a pattern of "google" would match "evil-google.com".
    // We now ONLY allow exact match or right-hand subdomain match.
    return h === p || h.endsWith("." + p);
  }

  // Build a single regex over a single pool of terms with a fixed case mode.
  // Kept exported for back-compat with anyone calling it directly (and used
  // internally by buildScanContext).
  function buildRegex(terms, opts) {
    const caseSensitive = !!(opts && opts.caseSensitive);
    const wholeWordOnly = !!(opts && opts.wholeWordOnly);
    const cleaned = (terms || [])
      .map(function (t) { return t == null ? "" : String(t).trim(); })
      .filter(Boolean);
    if (cleaned.length === 0) return null;

    // De-duplicate case-insensitively when matching is case-insensitive, so
    // "BAE" and "bae" don't both end up in the alternation. Keep the first
    // spelling encountered.
    const seen = new Set();
    const unique = [];
    for (const t of cleaned) {
      const key = caseSensitive ? t : t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    // Sort longest first so "BAE Systems" wins over "BAE" in JS regex
    // alternation (which is leftmost-first, not longest-first).
    unique.sort(function (a, b) { return b.length - a.length; });
    let source = "(" + unique.map(escapeRegex).join("|") + ")";
    if (wholeWordOnly) source = "\\b" + source + "\\b";
    const flags = "g" + (caseSensitive ? "" : "i");
    try {
      return new RegExp(source, flags);
    } catch (e) {
      // Should be impossible given escapeRegex, but never throw to callers.
      return null;
    }
  }

  // Build the per-page scan context from a (merged) config. Returns:
  //   { regexCI, regexCS, displayByKey, hasAny }
  // - regexCI matches CI-pool terms with the global caseSensitive flag.
  // - regexCS matches CS-pool terms, always case-sensitively.
  // - displayByKey maps the internal opaque key (e.g. "ci:nasa", "cs:NASA")
  //   to the user's originally-typed term, so the popup shows what they
  //   typed rather than the lowercased / matched form.
  function buildScanContext(input) {
    const config = input || {};
    const caseSensitive = !!config.caseSensitive;
    const wholeWordOnly = !!config.wholeWordOnly;
    const ciTerms = Array.isArray(config.terms) ? config.terms : [];
    const csTerms = Array.isArray(config.csTerms) ? config.csTerms : [];
    const regexCI = buildRegex(ciTerms, { caseSensitive: caseSensitive, wholeWordOnly: wholeWordOnly });
    const regexCS = buildRegex(csTerms, { caseSensitive: true, wholeWordOnly: wholeWordOnly });
    const displayByKey = new Map();
    for (const raw of ciTerms) {
      if (typeof raw !== "string") continue;
      const t = raw.trim();
      if (!t) continue;
      const key = "ci:" + (caseSensitive ? t : t.toLowerCase());
      if (!displayByKey.has(key)) displayByKey.set(key, t);
    }
    for (const raw of csTerms) {
      if (typeof raw !== "string") continue;
      const t = raw.trim();
      if (!t) continue;
      const key = "cs:" + t;
      if (!displayByKey.has(key)) displayByKey.set(key, t);
    }
    return {
      regexCI: regexCI,
      regexCS: regexCS,
      caseSensitive: caseSensitive,
      wholeWordOnly: wholeWordOnly,
      displayByKey: displayByKey,
      hasAny: !!(regexCI || regexCS)
    };
  }

  // Compute the opaque internal key for a matched substring within a pool.
  function keyForMatch(pool, matchedText, caseSensitive) {
    if (pool === "cs") return "cs:" + matchedText;
    return "ci:" + (caseSensitive ? matchedText : String(matchedText).toLowerCase());
  }

  // Run both pool regexes over a single text and return the ordered,
  // non-overlapping list of matches. Each entry:
  //   { start, end, text, pool, key }
  // Overlap resolution: matches are processed in (start asc, length desc)
  // order; once a match is emitted, any subsequent match whose start falls
  // before the previous end is skipped. This makes CS and CI pools coexist
  // cleanly (e.g. CS "NASA" wins over CI "nasa" at the same position only
  // because CS is processed first via stable sort).
  function runScan(text, ctx) {
    if (!text || !ctx || !ctx.hasAny) return [];
    const caseSensitive = !!(ctx.caseSensitive);
    const all = [];
    if (ctx.regexCS) {
      ctx.regexCS.lastIndex = 0;
      let m;
      while ((m = ctx.regexCS.exec(text)) !== null) {
        all.push({ start: m.index, end: m.index + m[0].length, text: m[0], pool: "cs" });
        if (m.index === ctx.regexCS.lastIndex) ctx.regexCS.lastIndex++;
      }
    }
    if (ctx.regexCI) {
      ctx.regexCI.lastIndex = 0;
      let m;
      while ((m = ctx.regexCI.exec(text)) !== null) {
        all.push({ start: m.index, end: m.index + m[0].length, text: m[0], pool: "ci" });
        if (m.index === ctx.regexCI.lastIndex) ctx.regexCI.lastIndex++;
      }
    }
    // Order: earliest start first; on tie, longer match wins; on tie, CS
    // wins (acronym-mode entries are more specific and user-curated).
    all.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      const la = a.end - a.start;
      const lb = b.end - b.start;
      if (la !== lb) return lb - la;
      if (a.pool !== b.pool) return a.pool === "cs" ? -1 : 1;
      return 0;
    });
    const out = [];
    let lastEnd = -1;
    for (const m of all) {
      if (m.start < lastEnd) continue;
      m.key = keyForMatch(m.pool, m.text, caseSensitive);
      out.push(m);
      lastEnd = m.end;
    }
    return out;
  }

  // Pure reconciliation of per-term bookkeeping after a DOM change. Given
  // two maps (rangesByTerm or spansByTerm) and a predicate `isLive(entry)`,
  // drops dead entries, removes empty keys, and recomputes matchCounts.
  // Returns { changed: boolean, matchCounts: Map<key, number> }.
  //
  // This is the pure core extracted so we can unit-test it without JSDOM.
  function reconcileBookkeeping(book, isLive) {
    let changed = false;
    const matchCounts = new Map();
    for (const [key, arr] of book) {
      const live = arr.filter(isLive);
      if (live.length !== arr.length) changed = true;
      if (live.length === 0) {
        book.delete(key);
        continue;
      }
      if (live.length !== arr.length) book.set(key, live);
      matchCounts.set(key, live.length);
    }
    return { changed: changed, matchCounts: matchCounts };
  }

  // Strict whitelist-based validation. Used by options.js when the user
  // imports a JSON config from disk AND on every save. We do NOT trust any
  // field type or any unknown keys. Anything malformed is silently coerced
  // to the default, and unknown top-level keys are dropped.
  function sanitizeImportedConfig(input) {
    const out = Object.assign({}, DEFAULT_CONFIG);
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;

    if (typeof input.enabled === "boolean") out.enabled = input.enabled;
    if (typeof input.caseSensitive === "boolean") out.caseSensitive = input.caseSensitive;
    if (typeof input.wholeWordOnly === "boolean") out.wholeWordOnly = input.wholeWordOnly;
    if (typeof input.highlightMatches === "boolean") out.highlightMatches = input.highlightMatches;

    out.globalTerms = sanitizeTermList(input.globalTerms);
    // Back-compat: pre-1.6 configs lack globalCsTerms entirely; default to [].
    out.globalCsTerms = sanitizeTermList(input.globalCsTerms);
    out.disabledHosts = sanitizeHostList(input.disabledHosts);
    out.siteRules = sanitizeSiteRules(input.siteRules);

    return out;
  }

  function sanitizeTermList(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const t of arr) {
      if (typeof t !== "string") continue;
      const trimmed = t.trim();
      if (!trimmed) continue;
      if (trimmed.length > LIMITS.MAX_TERM_LENGTH) continue;
      out.push(trimmed);
      if (out.length >= LIMITS.MAX_TERMS) break;
    }
    return out;
  }

  function sanitizeHostList(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const h of arr) {
      if (typeof h !== "string") continue;
      const trimmed = h.trim().toLowerCase();
      if (!trimmed) continue;
      if (trimmed.length > LIMITS.MAX_HOST_LENGTH) continue;
      // Reject anything that obviously isn't a hostname: whitespace,
      // slashes, schemes, control chars.
      if (/[\s\/\\?#@:]/.test(trimmed)) continue;
      out.push(trimmed);
      if (out.length >= LIMITS.MAX_DISABLED_HOSTS) break;
    }
    return out;
  }

  function sanitizeSiteRules(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const r of arr) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const pattern = typeof r.pattern === "string" ? r.pattern.trim().toLowerCase() : "";
      if (!pattern) continue;
      if (pattern.length > LIMITS.MAX_HOST_LENGTH) continue;
      if (/[\s\/\\?#@:]/.test(pattern)) continue;
      out.push({
        pattern: pattern,
        terms: sanitizeTermList(r.terms),
        // Back-compat: pre-1.6 rules lack csTerms; default to [].
        csTerms: sanitizeTermList(r.csTerms)
      });
      if (out.length >= LIMITS.MAX_SITE_RULES) break;
    }
    return out;
  }

  const api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    LIMITS: LIMITS,
    escapeRegex: escapeRegex,
    hostMatches: hostMatches,
    buildRegex: buildRegex,
    buildScanContext: buildScanContext,
    runScan: runScan,
    keyForMatch: keyForMatch,
    reconcileBookkeeping: reconcileBookkeeping,
    sanitizeImportedConfig: sanitizeImportedConfig,
    sanitizeTermList: sanitizeTermList,
    sanitizeHostList: sanitizeHostList,
    sanitizeSiteRules: sanitizeSiteRules
  };

  // Browser / extension context.
  if (root) root.BTWMatching = api;

  // Node (test) context.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : null));
