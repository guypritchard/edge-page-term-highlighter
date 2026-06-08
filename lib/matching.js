// lib/matching.js - pure helpers shared by content.js, background.js, and
// options.js. NO chrome.* API calls here. NO DOM access. This file is the
// security/regex/validation core, and is unit-tested under test/.
//
// Loaded as a classic script in extension contexts (no ES modules) AND
// required as a CommonJS module by the Node test runner (see bottom of file).
//
// v2.0.0 schema:
//   {
//     schemaVersion: 2,
//     enabled, wholeWordOnly, highlightMatches,
//     profiles: [{ id, name, scope, terms: ["confidential", "cs:NASA"] }]
//   }
// Each line in `terms` is either a plain term (case-insensitive) or the
// prefix `cs:` followed by a term that must match case-sensitively. This
// replaces the v1 globalTerms / globalCsTerms / siteRules / disabledHosts /
// global caseSensitive flag - all gone.
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 2;

  const DEFAULT_CONFIG = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    wholeWordOnly: true,
    highlightMatches: true,
    profiles: []
  });

  const LIMITS = Object.freeze({
    MAX_TERM_LENGTH: 200,
    MAX_PROFILE_TERMS: 5000,
    MAX_PROFILES: 500,
    MAX_NAME_LENGTH: 120,
    MAX_HOST_LENGTH: 253, // RFC 1035
    MAX_PATH_LENGTH: 2048,
    MAX_PATTERN_LENGTH: 2048
  });

  const CS_PREFIX = "cs:";

  const VALID_SCOPE_KINDS = Object.freeze([
    "anyUrl", "wholeSite", "hostOnly", "pathPrefix", "exactUrl", "matchPattern"
  ]);

  // ---------- generic ----------
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hostMatches(host, pattern) {
    if (!pattern) return false;
    const h = String(host || "").toLowerCase();
    const p = String(pattern).trim().toLowerCase();
    if (!p) return false;
    return h === p || h.endsWith("." + p);
  }

  function isValidHostString(h) {
    if (typeof h !== "string") return false;
    const t = h.trim();
    if (!t || t.length > LIMITS.MAX_HOST_LENGTH) return false;
    // No whitespace, no slashes, no schemes, no userinfo, no port.
    if (/[\s\/\\?#@:]/.test(t)) return false;
    // Must contain at least one alphanumeric (rejects ".", "..", etc.)
    if (!/[a-z0-9]/i.test(t)) return false;
    return true;
  }

  function isValidPath(p) {
    if (typeof p !== "string") return false;
    if (!p.startsWith("/")) return false;
    if (p.length > LIMITS.MAX_PATH_LENGTH) return false;
    // Control characters reject (rest is up to the URL).
    if (/[\x00-\x1f\x7f]/.test(p)) return false;
    return true;
  }

  // ---------- terms ----------
  // Parse one raw textarea line into a structured term. Returns null for
  // blank lines or lines whose body exceeds the term-length cap.
  function parseTermLine(line) {
    if (typeof line !== "string") return null;
    let s = line.replace(/[\r\n]+/g, "").trim();
    if (!s) return null;
    let caseSensitive = false;
    if (s.toLowerCase().startsWith(CS_PREFIX)) {
      caseSensitive = true;
      s = s.slice(CS_PREFIX.length).trim();
    }
    if (!s) return null;
    if (s.length > LIMITS.MAX_TERM_LENGTH) return null;
    return { text: s, caseSensitive: caseSensitive };
  }

  // Split raw term lines into the two pools the scanner uses.
  // Duplicates within a pool are dropped (preserving first-seen spelling).
  function splitTermPools(rawTerms) {
    const ci = [];
    const cs = [];
    const seenCi = new Set();
    const seenCs = new Set();
    const arr = Array.isArray(rawTerms) ? rawTerms : [];
    for (const line of arr) {
      const parsed = parseTermLine(line);
      if (!parsed) continue;
      if (parsed.caseSensitive) {
        if (seenCs.has(parsed.text)) continue;
        seenCs.add(parsed.text);
        cs.push(parsed.text);
      } else {
        const k = parsed.text.toLowerCase();
        if (seenCi.has(k)) continue;
        seenCi.add(k);
        ci.push(parsed.text);
      }
    }
    return { ci: ci, cs: cs };
  }

  function sanitizeTermList(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const raw of arr) {
      const parsed = parseTermLine(raw);
      if (!parsed) continue;
      // Re-emit in normalized form (the cs: prefix lowercased and trimmed).
      out.push(parsed.caseSensitive ? CS_PREFIX + parsed.text : parsed.text);
      if (out.length >= LIMITS.MAX_PROFILE_TERMS) break;
    }
    return out;
  }

  // ---------- URL parsing ----------
  // Safe URL parser: never throws. Returns null on garbage input.
  // The browser sees `location.href` so this is always well-formed in
  // practice, but tests + the match-pattern path want predictable behaviour.
  function parseUrl(href) {
    if (typeof href !== "string" || !href) return null;
    try {
      const u = new URL(href);
      const scheme = u.protocol.replace(/:$/, "").toLowerCase();
      return {
        scheme: scheme,
        host: u.hostname.toLowerCase(),
        path: u.pathname || "/"
      };
    } catch (e) {
      return null;
    }
  }

  // ---------- match-pattern parsing ----------
  // Subset of Chromium match patterns sufficient for our scopes:
  //   "<scheme>://<host><path>"
  // where:
  //   scheme = "*" | "http" | "https"
  //   host   = "*" | "*.exact.host" | "exact.host"
  //   path   = "/..."  (may contain "*" wildcards)
  // We do NOT accept the special "<all_urls>" literal; users pick the
  // dedicated "Any URL" scope kind for that.
  function parseMatchPattern(pattern) {
    if (typeof pattern !== "string") throw new Error("pattern must be a string");
    const trimmed = pattern.trim();
    if (!trimmed) throw new Error("pattern is empty");
    if (trimmed.length > LIMITS.MAX_PATTERN_LENGTH) throw new Error("pattern too long");
    const m = /^(\*|https?):\/\/([^\/]+)(\/.*)$/.exec(trimmed);
    if (!m) throw new Error("pattern must look like 'scheme://host/path'");
    const scheme = m[1].toLowerCase();
    const hostRaw = m[2].toLowerCase();
    const path = m[3];
    let includeSubdomains = false;
    let host = hostRaw;
    if (hostRaw === "*") {
      // Any host. Represented as host="*".
      includeSubdomains = true;
      host = "*";
    } else if (hostRaw.startsWith("*.")) {
      const rest = hostRaw.slice(2);
      if (!isValidHostString(rest)) throw new Error("invalid host after '*.'");
      includeSubdomains = true;
      host = rest;
    } else {
      if (hostRaw.indexOf("*") !== -1) throw new Error("'*' may only appear as '*' or '*.host'");
      if (!isValidHostString(hostRaw)) throw new Error("invalid host");
      includeSubdomains = false;
      host = hostRaw;
    }
    if (!isValidPath(path)) throw new Error("invalid path");
    return {
      kind: "matchPattern",
      pattern: trimmed,
      scheme: scheme,            // "*" | "http" | "https"
      host: host,                // "*" or a bare hostname
      includeSubdomains: includeSubdomains,
      path: path                 // may contain '*' wildcards
    };
  }

  // Convert a path glob (only '*' is wildcard, everything else literal)
  // to a regex that matches the full pathname.
  function pathGlobToRegex(glob) {
    const re = glob.split("*").map(escapeRegex).join(".*");
    return new RegExp("^" + re + "$");
  }

  // ---------- scopes ----------
  // Validate + normalize a raw scope object. Returns a clean scope or null.
  // No regex / RegExp instances are returned here - those are built lazily
  // inside scopeMatchesUrl. The returned shape is JSON-safe (stored as-is).
  function sanitizeScope(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const kind = String(input.kind || "");
    if (VALID_SCOPE_KINDS.indexOf(kind) === -1) return null;
    if (kind === "anyUrl") return { kind: "anyUrl" };
    if (kind === "wholeSite") {
      if (!isValidHostString(input.host)) return null;
      return { kind: "wholeSite", host: input.host.trim().toLowerCase() };
    }
    if (kind === "hostOnly") {
      if (!isValidHostString(input.host)) return null;
      return { kind: "hostOnly", host: input.host.trim().toLowerCase() };
    }
    if (kind === "pathPrefix") {
      if (!isValidHostString(input.host)) return null;
      const path = typeof input.path === "string" ? input.path.trim() : "";
      // Normalize: ensure leading slash, no trailing slash (except root).
      const p = path.startsWith("/") ? path : ("/" + path);
      if (!isValidPath(p)) return null;
      return { kind: "pathPrefix", host: input.host.trim().toLowerCase(), path: p };
    }
    if (kind === "exactUrl") {
      const scheme = String(input.scheme || "").toLowerCase();
      if (scheme !== "http" && scheme !== "https") return null;
      if (!isValidHostString(input.host)) return null;
      const path = typeof input.path === "string" ? input.path.trim() : "";
      const p = path.startsWith("/") ? path : ("/" + path);
      if (!isValidPath(p)) return null;
      return { kind: "exactUrl", scheme: scheme, host: input.host.trim().toLowerCase(), path: p };
    }
    if (kind === "matchPattern") {
      try {
        return parseMatchPattern(input.pattern);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // Pure predicate: does scope `s` match parsed URL `u`?
  // `u` is the {scheme, host, path} from parseUrl(). Falsy u => false.
  function scopeMatchesUrl(s, u) {
    if (!s || !u) return false;
    if (s.kind === "anyUrl") return true;
    if (s.kind === "wholeSite") {
      return (u.scheme === "http" || u.scheme === "https") && hostMatches(u.host, s.host);
    }
    if (s.kind === "hostOnly") {
      return (u.scheme === "http" || u.scheme === "https") && u.host === s.host;
    }
    if (s.kind === "pathPrefix") {
      if (u.scheme !== "http" && u.scheme !== "https") return false;
      if (!hostMatches(u.host, s.host)) return false;
      return pathStartsWithPrefix(u.path, s.path);
    }
    if (s.kind === "exactUrl") {
      return u.scheme === s.scheme && u.host === s.host && u.path === s.path;
    }
    if (s.kind === "matchPattern") {
      if (s.scheme !== "*" && s.scheme !== u.scheme) return false;
      if (s.host !== "*") {
        if (s.includeSubdomains) {
          if (!hostMatches(u.host, s.host)) return false;
        } else {
          if (u.host !== s.host) return false;
        }
      }
      // Path uses glob with '*'. Compile lazily and cache on the scope.
      if (!s.__pathRegex) {
        try { s.__pathRegex = pathGlobToRegex(s.path); }
        catch (e) { return false; }
      }
      return s.__pathRegex.test(u.path);
    }
    return false;
  }

  // Path prefix match with sensible "directory boundary" handling so that
  // a profile for "/r/news" doesn't accidentally match "/r/newsletter".
  function pathStartsWithPrefix(path, prefix) {
    if (!prefix || prefix === "/") return true;
    const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (path === p) return true;
    return path.startsWith(p + "/") || path.startsWith(p + "?") || path.startsWith(p + "#");
  }

  function profilesForUrl(profiles, href) {
    const u = parseUrl(href);
    if (!u || !Array.isArray(profiles)) return [];
    const out = [];
    for (const p of profiles) {
      if (!p || !p.scope) continue;
      if (scopeMatchesUrl(p.scope, u)) out.push(p);
    }
    return out;
  }

  // Human-readable one-line description of a scope for the UI.
  function describeScope(s) {
    if (!s) return "(invalid)";
    switch (s.kind) {
      case "anyUrl": return "Any URL";
      case "wholeSite": return "Whole site: " + s.host;
      case "hostOnly": return "Just hostname: " + s.host;
      case "pathPrefix": return "Path on site: " + s.host + s.path;
      case "exactUrl": return "Exact URL: " + s.scheme + "://" + s.host + s.path;
      case "matchPattern": return "Match pattern: " + s.pattern;
      default: return "(invalid)";
    }
  }

  // ---------- scan context ----------
  // Build the per-page scan context from a flat list of raw term lines
  // (possibly carrying `cs:` prefixes). Returns:
  //   { regexCI, regexCS, caseSensitive, wholeWordOnly, displayByKey, hasAny }
  // Internal keys are "ci:<lower>" or "cs:<exact>"; displayByKey maps each
  // back to the user's originally-typed term.
  function buildScanContext(input) {
    const wholeWordOnly = !!(input && input.wholeWordOnly);
    const split = splitTermPools(input && input.terms);
    const regexCI = compilePool(split.ci, { caseSensitive: false, wholeWordOnly: wholeWordOnly });
    const regexCS = compilePool(split.cs, { caseSensitive: true, wholeWordOnly: wholeWordOnly });
    const displayByKey = new Map();
    for (const t of split.ci) {
      const k = "ci:" + t.toLowerCase();
      if (!displayByKey.has(k)) displayByKey.set(k, t);
    }
    for (const t of split.cs) {
      const k = "cs:" + t;
      if (!displayByKey.has(k)) displayByKey.set(k, t);
    }
    return {
      regexCI: regexCI,
      regexCS: regexCS,
      caseSensitive: false, // CI pool drives this; CS pool is always case-sensitive irrespective
      wholeWordOnly: wholeWordOnly,
      displayByKey: displayByKey,
      hasAny: !!(regexCI || regexCS)
    };
  }

  function compilePool(terms, opts) {
    const cleaned = (terms || []).slice();
    if (cleaned.length === 0) return null;
    // Sort longest first so phrases beat substrings in JS alternation.
    cleaned.sort(function (a, b) { return b.length - a.length; });
    let source = "(" + cleaned.map(escapeRegex).join("|") + ")";
    if (opts.wholeWordOnly) source = "\\b" + source + "\\b";
    const flags = "g" + (opts.caseSensitive ? "" : "i");
    try { return new RegExp(source, flags); } catch (e) { return null; }
  }

  function keyForMatch(pool, matchedText, caseSensitive) {
    if (pool === "cs") return "cs:" + matchedText;
    return "ci:" + (caseSensitive ? matchedText : String(matchedText).toLowerCase());
  }

  function runScan(text, ctx) {
    if (!text || !ctx || !ctx.hasAny) return [];
    const caseSensitive = !!ctx.caseSensitive;
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
    all.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      const la = a.end - a.start, lb = b.end - b.start;
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

  function reconcileBookkeeping(book, isLive) {
    let changed = false;
    const matchCounts = new Map();
    for (const [key, arr] of book) {
      const live = arr.filter(isLive);
      if (live.length !== arr.length) changed = true;
      if (live.length === 0) { book.delete(key); continue; }
      if (live.length !== arr.length) book.set(key, live);
      matchCounts.set(key, live.length);
    }
    return { changed: changed, matchCounts: matchCounts };
  }

  // ---------- config sanitiser ----------
  function generateId() {
    // Try crypto.randomUUID() first (browser + recent Node). Fall back to a
    // simple base36 random for older runtimes / tests without crypto.
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function sanitizeProfile(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const scope = sanitizeScope(input.scope);
    if (!scope) return null;
    const terms = sanitizeTermList(input.terms);
    let name = "";
    if (typeof input.name === "string") {
      name = input.name.replace(/[\r\n\t]+/g, " ").trim().slice(0, LIMITS.MAX_NAME_LENGTH);
    }
    let id = "";
    if (typeof input.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) {
      id = input.id;
    } else {
      id = generateId();
    }
    // A profile with no terms is allowed (the user may be drafting); the
    // scanner just won't fire on it. But it must have a valid scope.
    return { id: id, name: name, scope: scope, terms: terms };
  }

  function sanitizeImportedConfig(input) {
    const out = {
      schemaVersion: SCHEMA_VERSION,
      enabled: DEFAULT_CONFIG.enabled,
      wholeWordOnly: DEFAULT_CONFIG.wholeWordOnly,
      highlightMatches: DEFAULT_CONFIG.highlightMatches,
      profiles: []
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;
    if (typeof input.enabled === "boolean") out.enabled = input.enabled;
    if (typeof input.wholeWordOnly === "boolean") out.wholeWordOnly = input.wholeWordOnly;
    if (typeof input.highlightMatches === "boolean") out.highlightMatches = input.highlightMatches;
    if (Array.isArray(input.profiles)) {
      for (const p of input.profiles) {
        const clean = sanitizeProfile(p);
        if (!clean) continue;
        out.profiles.push(clean);
        if (out.profiles.length >= LIMITS.MAX_PROFILES) break;
      }
    }
    return out;
  }

  const api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    LIMITS: LIMITS,
    CS_PREFIX: CS_PREFIX,
    VALID_SCOPE_KINDS: VALID_SCOPE_KINDS,
    escapeRegex: escapeRegex,
    hostMatches: hostMatches,
    isValidHostString: isValidHostString,
    isValidPath: isValidPath,
    parseTermLine: parseTermLine,
    splitTermPools: splitTermPools,
    sanitizeTermList: sanitizeTermList,
    parseUrl: parseUrl,
    parseMatchPattern: parseMatchPattern,
    sanitizeScope: sanitizeScope,
    scopeMatchesUrl: scopeMatchesUrl,
    profilesForUrl: profilesForUrl,
    describeScope: describeScope,
    buildScanContext: buildScanContext,
    runScan: runScan,
    keyForMatch: keyForMatch,
    reconcileBookkeeping: reconcileBookkeeping,
    sanitizeProfile: sanitizeProfile,
    sanitizeImportedConfig: sanitizeImportedConfig,
    generateId: generateId
  };

  if (root) root.PTHMatching = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : null));
