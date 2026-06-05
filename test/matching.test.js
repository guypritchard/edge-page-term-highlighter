// Unit tests for lib/matching.js (pure helpers) - v2.0.0 schema.
// Run with: node --test test/matching.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/matching.js");

// ---------- escapeRegex ----------
test("escapeRegex escapes all regex metacharacters", () => {
  const input = ".*+?^${}()|[]\\";
  const re = new RegExp("^" + M.escapeRegex(input) + "$");
  assert.ok(re.test(input));
});

test("escapeRegex coerces non-strings safely", () => {
  assert.equal(M.escapeRegex(null), "null");
  assert.equal(M.escapeRegex(undefined), "undefined");
  assert.equal(M.escapeRegex(42), "42");
});

// ---------- hostMatches ----------
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
test("hostMatches: no substring footgun", () => {
  assert.equal(M.hostMatches("evil-google.com", "google.com"), false);
  assert.equal(M.hostMatches("googleness.com", "google"), false);
});
test("hostMatches: empty / null inputs", () => {
  assert.equal(M.hostMatches("", "x"), false);
  assert.equal(M.hostMatches("x", ""), false);
  assert.equal(M.hostMatches(null, "x"), false);
});

// ---------- isValidHostString / isValidPath ----------
test("isValidHostString accepts plain hostnames", () => {
  assert.equal(M.isValidHostString("example.com"), true);
  assert.equal(M.isValidHostString("a"), true);
  assert.equal(M.isValidHostString("a.b.c.d"), true);
});
test("isValidHostString rejects junk", () => {
  assert.equal(M.isValidHostString(""), false);
  assert.equal(M.isValidHostString("..."), false);
  assert.equal(M.isValidHostString("http://x.com"), false);
  assert.equal(M.isValidHostString("x.com/foo"), false);
  assert.equal(M.isValidHostString("x.com:80"), false);
  assert.equal(M.isValidHostString("x y.com"), false);
  assert.equal(M.isValidHostString(null), false);
});
test("isValidPath requires leading slash and rejects controls", () => {
  assert.equal(M.isValidPath("/"), true);
  assert.equal(M.isValidPath("/foo/bar"), true);
  assert.equal(M.isValidPath("foo"), false);
  assert.equal(M.isValidPath("/\u0007"), false);
});

// ---------- parseTermLine ----------
test("parseTermLine handles plain term", () => {
  const p = M.parseTermLine("hello");
  assert.deepEqual(p, { text: "hello", caseSensitive: false });
});
test("parseTermLine handles cs: prefix", () => {
  const p = M.parseTermLine("cs:NASA");
  assert.deepEqual(p, { text: "NASA", caseSensitive: true });
});
test("parseTermLine cs: is case-insensitive prefix", () => {
  const p = M.parseTermLine("CS:NASA");
  assert.deepEqual(p, { text: "NASA", caseSensitive: true });
});
test("parseTermLine returns null for blank lines", () => {
  assert.equal(M.parseTermLine(""), null);
  assert.equal(M.parseTermLine("   "), null);
  assert.equal(M.parseTermLine("cs:   "), null);
});
test("parseTermLine drops overlength terms", () => {
  const big = "x".repeat(M.LIMITS.MAX_TERM_LENGTH + 1);
  assert.equal(M.parseTermLine(big), null);
});

// ---------- splitTermPools ----------
test("splitTermPools separates ci and cs pools", () => {
  const r = M.splitTermPools(["foo", "cs:NASA", "bar", "cs:API"]);
  assert.deepEqual(r.ci, ["foo", "bar"]);
  assert.deepEqual(r.cs, ["NASA", "API"]);
});
test("splitTermPools dedupes case-insensitively in ci pool", () => {
  const r = M.splitTermPools(["foo", "FOO", "Foo"]);
  assert.deepEqual(r.ci, ["foo"]);
});
test("splitTermPools dedupes exactly in cs pool", () => {
  const r = M.splitTermPools(["cs:NASA", "cs:nasa", "cs:NASA"]);
  assert.deepEqual(r.cs, ["NASA", "nasa"]);
});

// ---------- sanitizeTermList ----------
test("sanitizeTermList normalizes cs: prefix and trims", () => {
  const r = M.sanitizeTermList(["  foo  ", "CS:NASA", "", null, "bar"]);
  assert.deepEqual(r, ["foo", "cs:NASA", "bar"]);
});
test("sanitizeTermList caps at MAX_PROFILE_TERMS", () => {
  const big = new Array(M.LIMITS.MAX_PROFILE_TERMS + 50).fill(0).map((_, i) => "t" + i);
  assert.equal(M.sanitizeTermList(big).length, M.LIMITS.MAX_PROFILE_TERMS);
});

// ---------- parseUrl ----------
test("parseUrl returns parts for valid URLs", () => {
  assert.deepEqual(M.parseUrl("https://Example.com/foo?x=1"), { scheme: "https", host: "example.com", path: "/foo" });
  assert.deepEqual(M.parseUrl("http://x/"), { scheme: "http", host: "x", path: "/" });
});
test("parseUrl returns null for garbage", () => {
  assert.equal(M.parseUrl("not a url"), null);
  assert.equal(M.parseUrl(""), null);
  assert.equal(M.parseUrl(null), null);
});

// ---------- parseMatchPattern ----------
test("parseMatchPattern: scheme any + wildcard host", () => {
  const p = M.parseMatchPattern("*://*/*");
  assert.equal(p.scheme, "*");
  assert.equal(p.host, "*");
  assert.equal(p.includeSubdomains, true);
  assert.equal(p.path, "/*");
});
test("parseMatchPattern: *.host means include subdomains", () => {
  const p = M.parseMatchPattern("https://*.example.com/*");
  assert.equal(p.host, "example.com");
  assert.equal(p.includeSubdomains, true);
});
test("parseMatchPattern: bare host excludes subdomains", () => {
  const p = M.parseMatchPattern("https://example.com/*");
  assert.equal(p.host, "example.com");
  assert.equal(p.includeSubdomains, false);
});
test("parseMatchPattern: rejects malformed patterns", () => {
  assert.throws(() => M.parseMatchPattern(""));
  assert.throws(() => M.parseMatchPattern("ftp://x/"));
  assert.throws(() => M.parseMatchPattern("https://x"));
  assert.throws(() => M.parseMatchPattern("https://*x.com/*"));
  assert.throws(() => M.parseMatchPattern("https://x/y\u0007"));
});

// ---------- sanitizeScope ----------
test("sanitizeScope: anyUrl normalises", () => {
  assert.deepEqual(M.sanitizeScope({ kind: "anyUrl", host: "ignored" }), { kind: "anyUrl" });
});
test("sanitizeScope: wholeSite lowercases host", () => {
  assert.deepEqual(M.sanitizeScope({ kind: "wholeSite", host: "Example.COM" }), { kind: "wholeSite", host: "example.com" });
});
test("sanitizeScope: pathPrefix adds leading slash", () => {
  assert.deepEqual(M.sanitizeScope({ kind: "pathPrefix", host: "x.com", path: "news" }),
    { kind: "pathPrefix", host: "x.com", path: "/news" });
});
test("sanitizeScope: exactUrl requires http/https", () => {
  assert.equal(M.sanitizeScope({ kind: "exactUrl", scheme: "ftp", host: "x.com", path: "/" }), null);
  assert.deepEqual(M.sanitizeScope({ kind: "exactUrl", scheme: "HTTPS", host: "x.com", path: "/" }),
    { kind: "exactUrl", scheme: "https", host: "x.com", path: "/" });
});
test("sanitizeScope: matchPattern via parseMatchPattern", () => {
  const s = M.sanitizeScope({ kind: "matchPattern", pattern: "https://*.example.com/news/*" });
  assert.equal(s.kind, "matchPattern");
  assert.equal(s.host, "example.com");
  assert.equal(s.includeSubdomains, true);
});
test("sanitizeScope: rejects unknown kind", () => {
  assert.equal(M.sanitizeScope({ kind: "bogus" }), null);
  assert.equal(M.sanitizeScope(null), null);
});

// ---------- scopeMatchesUrl ----------
test("scopeMatchesUrl: anyUrl matches anything parseable", () => {
  assert.equal(M.scopeMatchesUrl({ kind: "anyUrl" }, M.parseUrl("https://x.com/y")), true);
});
test("scopeMatchesUrl: wholeSite includes subdomains, http/https only", () => {
  const s = { kind: "wholeSite", host: "example.com" };
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://example.com/x")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://www.example.com/x")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("ftp://example.com/x")), false);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://evil-example.com/x")), false);
});
test("scopeMatchesUrl: hostOnly rejects subdomains", () => {
  const s = { kind: "hostOnly", host: "example.com" };
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://example.com/")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://www.example.com/")), false);
});
test("scopeMatchesUrl: pathPrefix respects directory boundary", () => {
  const s = { kind: "pathPrefix", host: "reddit.com", path: "/r/news" };
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://reddit.com/r/news")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://reddit.com/r/news/")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://reddit.com/r/news/foo")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://reddit.com/r/newsletter")), false);
});
test("scopeMatchesUrl: exactUrl requires scheme+host+path equality", () => {
  const s = { kind: "exactUrl", scheme: "https", host: "x.com", path: "/foo" };
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://x.com/foo")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("http://x.com/foo")), false);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://x.com/foo/bar")), false);
});
test("scopeMatchesUrl: matchPattern wildcard host + path glob", () => {
  const s = M.sanitizeScope({ kind: "matchPattern", pattern: "*://*.example.com/news/*" });
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://www.example.com/news/abc")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("http://example.com/news/abc")), true);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://example.org/news/abc")), false);
  assert.equal(M.scopeMatchesUrl(s, M.parseUrl("https://www.example.com/about")), false);
});

// ---------- profilesForUrl ----------
test("profilesForUrl returns matching profiles only", () => {
  const profiles = [
    { id: "1", scope: { kind: "wholeSite", host: "example.com" }, terms: ["a"] },
    { id: "2", scope: { kind: "wholeSite", host: "other.com" }, terms: ["b"] },
    { id: "3", scope: { kind: "anyUrl" }, terms: ["c"] }
  ];
  const r = M.profilesForUrl(profiles, "https://www.example.com/x");
  assert.deepEqual(r.map(p => p.id), ["1", "3"]);
});
test("profilesForUrl returns [] for garbage URL", () => {
  assert.deepEqual(M.profilesForUrl([{ scope: { kind: "anyUrl" } }], "not a url"), []);
});

// ---------- describeScope ----------
test("describeScope produces a human string per kind", () => {
  assert.match(M.describeScope({ kind: "anyUrl" }), /Any URL/);
  assert.match(M.describeScope({ kind: "wholeSite", host: "x.com" }), /x\.com/);
  assert.match(M.describeScope({ kind: "pathPrefix", host: "x.com", path: "/y" }), /x\.com\/y/);
  assert.equal(M.describeScope(null), "(invalid)");
});

// ---------- buildScanContext / runScan ----------
test("buildScanContext: empty terms => hasAny false", () => {
  const ctx = M.buildScanContext({ terms: [], wholeWordOnly: true });
  assert.equal(ctx.hasAny, false);
});
test("runScan: ci pool case-insensitive, wholeWord", () => {
  const ctx = M.buildScanContext({ terms: ["foo"], wholeWordOnly: true });
  const r = M.runScan("Foo bar foobaz FOO.", ctx);
  // Matches: "Foo" at 0, "FOO" at 15. Not "foobaz".
  assert.equal(r.length, 2);
  assert.equal(r[0].key, "ci:foo");
  assert.equal(r[0].text, "Foo");
  assert.equal(r[1].text, "FOO");
});
test("runScan: cs pool only matches exact case", () => {
  const ctx = M.buildScanContext({ terms: ["cs:NASA"], wholeWordOnly: true });
  const r = M.runScan("NASA and nasa.", ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, "cs:NASA");
  assert.equal(r[0].text, "NASA");
});
test("runScan: longest match wins on ties", () => {
  const ctx = M.buildScanContext({ terms: ["BAE Systems", "BAE"], wholeWordOnly: true });
  const r = M.runScan("Visit BAE Systems today.", ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "BAE Systems");
});
test("runScan: cs wins tie over ci", () => {
  const ctx = M.buildScanContext({ terms: ["cs:Foo", "foo"], wholeWordOnly: true });
  const r = M.runScan("Foo", ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].pool, "cs");
});
test("runScan: ci + cs both contribute", () => {
  const ctx = M.buildScanContext({ terms: ["cs:NASA", "rocket"], wholeWordOnly: true });
  const r = M.runScan("The NASA rocket launched.", ctx);
  const keys = r.map(m => m.key).sort();
  assert.deepEqual(keys, ["ci:rocket", "cs:NASA"]);
});
test("runScan: displayByKey preserves user-typed spelling", () => {
  const ctx = M.buildScanContext({ terms: ["Foo Bar"], wholeWordOnly: true });
  assert.equal(ctx.displayByKey.get("ci:foo bar"), "Foo Bar");
});
test("runScan: wholeWordOnly=false matches substrings", () => {
  const ctx = M.buildScanContext({ terms: ["foo"], wholeWordOnly: false });
  const r = M.runScan("foobar", ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "foo");
});

// ---------- keyForMatch ----------
test("keyForMatch: ci pool lowercases by default", () => {
  assert.equal(M.keyForMatch("ci", "Foo", false), "ci:foo");
});
test("keyForMatch: cs pool preserves case", () => {
  assert.equal(M.keyForMatch("cs", "NASA", false), "cs:NASA");
});

// ---------- reconcileBookkeeping ----------
test("reconcileBookkeeping drops dead entries and empty keys", () => {
  const live = new Set(["a", "c"]);
  const book = new Map([
    ["k1", ["a", "b"]],   // b dies
    ["k2", ["c"]],        // all live
    ["k3", ["b", "b"]]    // all die -> key removed
  ]);
  const res = M.reconcileBookkeeping(book, x => live.has(x));
  assert.equal(res.changed, true);
  assert.deepEqual(Array.from(book.keys()).sort(), ["k1", "k2"]);
  assert.deepEqual(res.matchCounts.get("k1"), 1);
  assert.deepEqual(res.matchCounts.get("k2"), 1);
});
test("reconcileBookkeeping returns changed=false when nothing died", () => {
  const book = new Map([["k", ["a", "b"]]]);
  const res = M.reconcileBookkeeping(book, () => true);
  assert.equal(res.changed, false);
  assert.equal(res.matchCounts.get("k"), 2);
});

// ---------- sanitizeImportedConfig ----------
test("sanitizeImportedConfig: empty input gets defaults", () => {
  const c = M.sanitizeImportedConfig({});
  assert.equal(c.schemaVersion, M.SCHEMA_VERSION);
  assert.equal(c.enabled, true);
  assert.equal(c.wholeWordOnly, true);
  assert.equal(c.highlightMatches, true);
  assert.deepEqual(c.profiles, []);
});
test("sanitizeImportedConfig: drops unknown top-level keys", () => {
  const c = M.sanitizeImportedConfig({ enabled: false, wholeWordOnly: false, profiles: [], evil: 1 });
  assert.equal(c.enabled, false);
  assert.equal(c.wholeWordOnly, false);
  assert.equal("evil" in c, false);
});
test("sanitizeImportedConfig: rejects invalid profiles", () => {
  const c = M.sanitizeImportedConfig({
    profiles: [
      { name: "good", scope: { kind: "anyUrl" }, terms: ["a"] },
      { name: "bad scope", scope: { kind: "bogus" }, terms: ["a"] },
      { name: "bad host", scope: { kind: "wholeSite", host: "http://x.com" }, terms: ["a"] },
      null,
      "not an object"
    ]
  });
  assert.equal(c.profiles.length, 1);
  assert.equal(c.profiles[0].name, "good");
});
test("sanitizeImportedConfig: caps profiles at MAX_PROFILES", () => {
  const big = new Array(M.LIMITS.MAX_PROFILES + 5).fill(0)
    .map((_, i) => ({ scope: { kind: "anyUrl" }, terms: ["t" + i] }));
  const c = M.sanitizeImportedConfig({ profiles: big });
  assert.equal(c.profiles.length, M.LIMITS.MAX_PROFILES);
});
test("sanitizeImportedConfig: round-trips cs: prefix", () => {
  const c = M.sanitizeImportedConfig({
    profiles: [{ scope: { kind: "anyUrl" }, terms: ["foo", "cs:NASA"] }]
  });
  assert.deepEqual(c.profiles[0].terms, ["foo", "cs:NASA"]);
});

// ---------- generateId ----------
test("generateId returns a non-empty string", () => {
  const a = M.generateId();
  const b = M.generateId();
  assert.equal(typeof a, "string");
  assert.notEqual(a, b);
});
