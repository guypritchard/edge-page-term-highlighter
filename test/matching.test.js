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
