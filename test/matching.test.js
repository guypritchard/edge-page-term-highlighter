// Unit tests for lib/matching.js (pure helpers).
// Run with: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/matching.js");

test("escapeRegex escapes all regex metacharacters", () => {
  const input = ".*+?^${}()|[]\\";
  const out = M.escapeRegex(input);
  // Round-trip: building a regex from the escaped string and matching
  // against the original must match exactly.
  const re = new RegExp("^" + out + "$");
  assert.ok(re.test(input));
});

test("escapeRegex coerces non-strings safely", () => {
  assert.equal(M.escapeRegex(null), "null");
  assert.equal(M.escapeRegex(undefined), "undefined");
  assert.equal(M.escapeRegex(42), "42");
});

test("hostMatches: exact match", () => {
  assert.equal(M.hostMatches("example.com", "example.com"), true);
});

test("hostMatches: case-insensitive", () => {
  assert.equal(M.hostMatches("EXAMPLE.com", "example.COM"), true);
});

test("hostMatches: subdomain match", () => {
  assert.equal(M.hostMatches("www.example.com", "example.com"), true);
  assert.equal(M.hostMatches("a.b.example.com", "example.com"), true);
});

test("hostMatches: does NOT do substring match (security)", () => {
  // The pre-1.5 behaviour matched "google" against "evil-google.com" via
  // .includes(). That footgun must stay closed.
  assert.equal(M.hostMatches("evil-google.com", "google"), false);
  assert.equal(M.hostMatches("googleblog.com", "google"), false);
  assert.equal(M.hostMatches("notexample.com", "example.com"), false);
});

test("hostMatches: empty / falsy inputs return false", () => {
  assert.equal(M.hostMatches("", "example.com"), false);
  assert.equal(M.hostMatches("example.com", ""), false);
  assert.equal(M.hostMatches("example.com", "   "), false);
  assert.equal(M.hostMatches(null, "example.com"), false);
  assert.equal(M.hostMatches("example.com", null), false);
});

test("buildRegex returns null for empty input", () => {
  assert.equal(M.buildRegex([], {}), null);
  assert.equal(M.buildRegex(null, {}), null);
  assert.equal(M.buildRegex(["", "   ", null], {}), null);
});

test("buildRegex matches a basic term, case-insensitive by default", () => {
  const re = M.buildRegex(["banned"], {});
  assert.ok(re);
  assert.ok(re.test("This is BaNnEd content"));
});

test("buildRegex caseSensitive=true is case sensitive", () => {
  const re = M.buildRegex(["Banned"], { caseSensitive: true });
  assert.ok(re.test("a Banned word"));
  re.lastIndex = 0;
  assert.equal(re.test("a banned word"), false);
});

test("buildRegex wholeWordOnly wraps with \\b", () => {
  const re = M.buildRegex(["bae"], { wholeWordOnly: true });
  assert.ok(re.test("bae alone"));
  re.lastIndex = 0;
  assert.equal(re.test("baseball"), false);
});

test("buildRegex sorts longest-first so phrases win over substrings", () => {
  const re = M.buildRegex(["BAE", "BAE Systems"], { caseSensitive: false });
  const text = "BAE Systems builds things and BAE alone too";
  const found = text.match(re).map(s => s.toLowerCase());
  // First match should be the longer phrase, not "BAE" inside it.
  assert.equal(found[0], "bae systems");
});

test("buildRegex de-duplicates case-insensitively", () => {
  const re = M.buildRegex(["BAE", "bae", "Bae"], { caseSensitive: false });
  assert.equal(re.source.split("|").length, 1, "should collapse to a single alternative");
});

test("buildRegex escapes regex metacharacters in terms", () => {
  const re = M.buildRegex(["a.b", "c+d"], { caseSensitive: false });
  assert.ok(re.test("a.b"));
  re.lastIndex = 0;
  assert.equal(re.test("aXb"), false, "the dot must be literal, not 'any char'");
});

test("sanitizeImportedConfig: rejects non-objects, returns defaults", () => {
  assert.deepEqual(M.sanitizeImportedConfig(null), M.DEFAULT_CONFIG);
  assert.deepEqual(M.sanitizeImportedConfig("hello"), M.DEFAULT_CONFIG);
  assert.deepEqual(M.sanitizeImportedConfig(42), M.DEFAULT_CONFIG);
  assert.deepEqual(M.sanitizeImportedConfig([]), M.DEFAULT_CONFIG);
});

test("sanitizeImportedConfig: drops unknown top-level keys", () => {
  const out = M.sanitizeImportedConfig({
    enabled: false,
    secretPayload: "boom",
    __proto__hack: 1
  });
  assert.equal(out.enabled, false);
  assert.equal("secretPayload" in out, false);
  assert.equal("__proto__hack" in out, false);
});

test("sanitizeImportedConfig: coerces non-boolean flags to defaults", () => {
  const out = M.sanitizeImportedConfig({
    enabled: "yes please",
    caseSensitive: 1,
    wholeWordOnly: null
  });
  assert.equal(out.enabled, true);  // default
  assert.equal(out.caseSensitive, false); // default
  assert.equal(out.wholeWordOnly, true); // default
});

test("sanitizeTermList: drops non-strings, blanks, and over-long", () => {
  const out = M.sanitizeTermList(["ok", "", "  ", 42, null, "x".repeat(201)]);
  assert.deepEqual(out, ["ok"]);
});

test("sanitizeTermList: enforces MAX_TERMS", () => {
  const big = new Array(M.LIMITS.MAX_TERMS + 100).fill("t");
  assert.equal(M.sanitizeTermList(big).length, M.LIMITS.MAX_TERMS);
});

test("sanitizeHostList: rejects URL-like strings, schemes, slashes", () => {
  const out = M.sanitizeHostList([
    "example.com",
    "https://evil.com",
    "a b.com",
    "x/y",
    "user@host",
    "host:port",
    "ok.example.org"
  ]);
  assert.deepEqual(out, ["example.com", "ok.example.org"]);
});

test("sanitizeSiteRules: requires a non-empty pattern", () => {
  const out = M.sanitizeSiteRules([
    { pattern: "", terms: ["a"] },
    { pattern: "example.com", terms: ["a", "b"] },
    null,
    "not an object",
    { pattern: 42, terms: [] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pattern, "example.com");
  assert.deepEqual(out[0].terms, ["a", "b"]);
});

test("sanitizeSiteRules: lowercases pattern and rejects URL-like garbage", () => {
  const out = M.sanitizeSiteRules([
    { pattern: "Example.COM", terms: ["a"] },
    { pattern: "http://x", terms: [] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pattern, "example.com");
});

test("DEFAULT_CONFIG is frozen", () => {
  "use strict";
  assert.throws(() => { M.DEFAULT_CONFIG.enabled = false; }, /./);
  assert.equal(M.DEFAULT_CONFIG.enabled, true);
});

// ---------- v1.6.0: csTerms ("acronym mode") ----------

test("DEFAULT_CONFIG has globalCsTerms as an empty array", () => {
  assert.ok(Array.isArray(M.DEFAULT_CONFIG.globalCsTerms));
  assert.equal(M.DEFAULT_CONFIG.globalCsTerms.length, 0);
});

test("sanitizeImportedConfig: accepts globalCsTerms and back-fills when missing", () => {
  const withIt = M.sanitizeImportedConfig({ globalCsTerms: ["NASA", "API"] });
  assert.deepEqual(withIt.globalCsTerms, ["NASA", "API"]);
  // Legacy config with no globalCsTerms field at all - must not throw, must default to [].
  const legacy = M.sanitizeImportedConfig({ globalTerms: ["x"] });
  assert.deepEqual(legacy.globalCsTerms, []);
});

test("sanitizeImportedConfig: drops non-string entries in globalCsTerms", () => {
  const out = M.sanitizeImportedConfig({ globalCsTerms: ["OK", 42, null, "", "  ", "x".repeat(201)] });
  assert.deepEqual(out.globalCsTerms, ["OK"]);
});

test("sanitizeSiteRules: accepts csTerms and back-fills to [] for legacy rules", () => {
  const out = M.sanitizeSiteRules([
    { pattern: "example.com", terms: ["a"], csTerms: ["NASA"] },
    { pattern: "old.com", terms: ["b"] } // legacy shape, pre-1.6
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].csTerms, ["NASA"]);
  assert.deepEqual(out[1].csTerms, []);
});

test("buildScanContext: returns null pools when both lists are empty", () => {
  const ctx = M.buildScanContext({ terms: [], csTerms: [] });
  assert.equal(ctx.hasAny, false);
  assert.equal(ctx.regexCI, null);
  assert.equal(ctx.regexCS, null);
});

test("buildScanContext: builds a CI regex (with global flag) and a CS regex", () => {
  const ctx = M.buildScanContext({ terms: ["banned"], csTerms: ["NASA"], caseSensitive: false, wholeWordOnly: true });
  assert.ok(ctx.regexCI);
  assert.ok(ctx.regexCS);
  // CI regex is case-insensitive.
  assert.ok(ctx.regexCI.flags.includes("i"));
  // CS regex is NOT case-insensitive.
  assert.equal(ctx.regexCS.flags.includes("i"), false);
});

test("buildScanContext: displayByKey preserves the user's typed spelling", () => {
  const ctx = M.buildScanContext({ terms: ["Banned"], csTerms: ["NASA"], caseSensitive: false });
  assert.equal(ctx.displayByKey.get("ci:banned"), "Banned");
  assert.equal(ctx.displayByKey.get("cs:NASA"), "NASA");
});

test("runScan: CS pool matches only exact-case; CI pool ignores case", () => {
  const ctx = M.buildScanContext({ terms: ["banned"], csTerms: ["NASA"], caseSensitive: false, wholeWordOnly: false });
  const hits = M.runScan("BANNED talk about nasa and NASA today", ctx);
  // "BANNED" via CI pool (any case), "NASA" via CS pool (only the uppercase one).
  const keys = hits.map(h => h.key);
  assert.ok(keys.includes("ci:banned"));
  assert.ok(keys.includes("cs:NASA"));
  // Lowercase "nasa" must NOT have produced a "cs:nasa" entry.
  assert.equal(keys.some(k => k === "cs:nasa"), false);
});

test("runScan: emits non-overlapping matches, earliest first, longest wins on tie", () => {
  const ctx = M.buildScanContext({ terms: ["BAE", "BAE Systems"], csTerms: [], wholeWordOnly: false });
  const hits = M.runScan("BAE Systems is bigger than BAE alone", ctx);
  assert.equal(hits.length, 2);
  // First hit is the longer phrase at the leftmost position.
  assert.equal(hits[0].text.toLowerCase(), "bae systems");
  assert.equal(hits[1].text.toLowerCase(), "bae");
  // Second hit starts after the first ends.
  assert.ok(hits[1].start >= hits[0].end);
});

test("runScan: at the same start, CS pool wins the tie over CI", () => {
  const ctx = M.buildScanContext({ terms: ["nasa"], csTerms: ["NASA"], caseSensitive: false, wholeWordOnly: false });
  const hits = M.runScan("NASA launches today", ctx);
  // Both pools would match "NASA" at index 0 with the same length; CS wins.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pool, "cs");
  assert.equal(hits[0].key, "cs:NASA");
});

test("runScan: empty / no-context inputs return []", () => {
  assert.deepEqual(M.runScan("", null), []);
  assert.deepEqual(M.runScan("hello", M.buildScanContext({ terms: [], csTerms: [] })), []);
  assert.deepEqual(M.runScan("", M.buildScanContext({ terms: ["x"], csTerms: [] })), []);
});

// ---------- v1.6.0: reconcileBookkeeping ----------

test("reconcileBookkeeping: drops dead entries and recomputes counts", () => {
  const book = new Map();
  book.set("ci:a", [{ id: 1, live: true }, { id: 2, live: false }, { id: 3, live: true }]);
  book.set("ci:b", [{ id: 4, live: false }]); // whole key dies
  book.set("ci:c", [{ id: 5, live: true }]);  // unchanged
  const res = M.reconcileBookkeeping(book, (e) => e.live);
  assert.equal(res.changed, true);
  assert.equal(book.has("ci:b"), false, "empty key should be removed entirely");
  assert.equal(book.get("ci:a").length, 2);
  assert.equal(book.get("ci:c").length, 1);
  assert.equal(res.matchCounts.get("ci:a"), 2);
  assert.equal(res.matchCounts.get("ci:c"), 1);
  assert.equal(res.matchCounts.has("ci:b"), false);
});

test("reconcileBookkeeping: returns changed=false when nothing died", () => {
  const book = new Map();
  book.set("ci:a", [{ live: true }, { live: true }]);
  const res = M.reconcileBookkeeping(book, (e) => e.live);
  assert.equal(res.changed, false);
  assert.equal(res.matchCounts.get("ci:a"), 2);
});
