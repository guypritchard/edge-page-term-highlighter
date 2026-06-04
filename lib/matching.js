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
  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    caseSensitive: false,
    wholeWordOnly: true,
    highlightMatches: true,
    globalTerms: [],
    siteRules: [],
    disabledHosts: []
  });

  // Hard caps. Anything beyond these is almost certainly a mistake or an
  // attempt to DoS the regex engine / storage quota. Reject on import.
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

  // Strict whitelist-based validation. Used by options.js when the user
  // imports a JSON config from disk. We do NOT trust any field type or
  // any unknown keys. Anything malformed is silently coerced to the
  // default, and unknown top-level keys are dropped.
  function sanitizeImportedConfig(input) {
    const out = Object.assign({}, DEFAULT_CONFIG);
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;

    if (typeof input.enabled === "boolean") out.enabled = input.enabled;
    if (typeof input.caseSensitive === "boolean") out.caseSensitive = input.caseSensitive;
    if (typeof input.wholeWordOnly === "boolean") out.wholeWordOnly = input.wholeWordOnly;
    if (typeof input.highlightMatches === "boolean") out.highlightMatches = input.highlightMatches;

    out.globalTerms = sanitizeTermList(input.globalTerms);
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
      out.push({ pattern: pattern, terms: sanitizeTermList(r.terms) });
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
