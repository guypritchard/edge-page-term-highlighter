# AGENTS.md

Operating guide for AI coding agents (and humans) working on the
**Page Term Highlighter** Microsoft Edge / Chromium extension.

This file captures every cross-cutting decision we have made about how the
extension is built, packaged, released, and hardened. Read it in full before
making changes - especially anything that touches storage, the DOM, the
release pipeline, or the manifest.

---

## 1. What this extension is

- A **Manifest V3** browser extension that scans every page's visible text
  for user-configured terms.
- On match: shows a red ⚠️ banner (in a closed shadow root), paints a
  highlight on each match, optionally injects a ⚠️ marker beside each
  match, and exposes the match list in the toolbar popup with
  **scroll-to-match** controls.
- Runs in Microsoft Edge primarily, but also Chrome / Brave / Opera and any
  other Chromium-based browser via the same package.

## 2. Non-negotiable principles

1. **Zero network calls.** Never add `fetch`, `XMLHttpRequest`,
   `WebSocket`, or any analytics/telemetry. Privacy is the point.
2. **Zero runtime dependencies.** Vanilla JS / HTML / CSS only. No `npm`
   packages in the shipped ZIP. No bundlers.
3. **Local-first storage.** New installs default to
   `chrome.storage.local`. `chrome.storage.sync` is opt-in only.
4. **No leakage of the configured term list to web pages.** Anything we
   inject into the page must not carry the configured terms in attributes
   or accessible properties.
5. **Defensive observation, not aggressive mutation.** Prefer the CSS
   Custom Highlight API where possible. When we must mutate the DOM, use
   minimal, opaque markers and never touch user inputs / contenteditable
   regions / `<script>` / `<style>` / `<code>` / `<pre>` / iframes / SVG /
   canvas.
6. **No emojis in code / docs unless the user explicitly asks for them.**
   The ⚠️ in the banner and markers IS asked-for product behaviour and
   stays.

## 3. Repository layout

```
.
├── manifest.json              # MV3 manifest. Version here drives releases.
│                              #   Declares strict CSP + minimum_chrome_version.
├── background.js              # Service worker (badge state, install hook,
│                              #   strict sender-origin check).
├── content.js                 # Page scanner, highlight engine, marker UI,
│                              #   MutationObserver, SPA hooks, popup IPC.
├── lib/
│   ├── config.js              # Shared storage helpers (PTHConfig namespace).
│   └── matching.js            # PURE helpers (PTHMatching): regex builder,
│                              #   term parsing (cs: prefix), URL + scope
│                              #   parsing, hostMatches, DEFAULT_CONFIG,
│                              #   sanitiser. No chrome.*, no DOM - unit
│                              #   tested.
├── popup.html / popup.js      # Toolbar popup. Match list + scroll-to.
├── options.html / options.js  # Full settings page (incl. storage area
│                              #   radio). Uses PTHMatching for sanitising
│                              #   imported JSON and saved config.
├── test/
│   ├── matching.test.js       # node:test unit tests for PTHMatching.
│   └── config.test.js         # node:test tests for PTHConfig with a
│                              #   chrome.storage stub loaded via vm.
├── icons/                     # 16 / 48 / 128 PNGs, generated locally.
├── .github/
│   ├── dependabot.yml         # Weekly Action updates.
│   └── workflows/
│       ├── validate.yml       # manifest + CSP check + lint + node --test.
│       ├── release.yml        # Tag-driven ZIP + SHA256 + GH Release.
│       └── codeql.yml         # JavaScript SAST.
├── README.md                  # End-user docs.
├── AGENTS.md                  # THIS FILE.
└── LICENSE                    # MIT.
```

The four execution contexts each load `lib/config.js` and `lib/matching.js`:

| Context        | How libs are loaded                                                              |
|----------------|----------------------------------------------------------------------------------|
| Content script | `content_scripts.js: ["lib/config.js", "lib/matching.js", "content.js"]` in manifest |
| Service worker | `importScripts("lib/config.js", "lib/matching.js")` at top of `background.js`    |
| Popup page     | `<script src="lib/config.js"></script>` then `popup.js` (no matching needed)     |
| Options page   | `<script src="lib/config.js"></script><script src="lib/matching.js"></script>`   |
| Node tests     | `require("../lib/matching.js")`; `config.js` loaded via `vm` with chrome stub.   |

Both `lib/config.js` and `lib/matching.js` deliberately use **no ES module
syntax** so they work in every loader type. `lib/matching.js` additionally
exports via `module.exports` when running in Node, for the test suite.

## 4. Storage model

- A small pointer at `chrome.storage.local["storageArea"]` selects the
  active area: `"local"` (default) or `"sync"`.
- The actual config lives at `chrome.storage.<area>["config"]`.
- All reads/writes go through `PTHConfig` in `lib/config.js`. Never call
  `chrome.storage.sync.get` / `.set` / `.local.get` / `.local.set` for the
  `config` key directly from anywhere else. Always go through the helper.
- `PTHConfig.onConfigChanged(cb)` invokes `cb` whenever the active config
  changes OR the area pointer flips - subscribe instead of listening to
  `chrome.storage.onChanged` ad-hoc.
- When the user toggles the storage area, `PTHConfig.setActiveAreaName`
  migrates the existing config from the old area to the new one and
  deletes it from the old. Quota errors (sync limit ~100 KB) must surface
  to the UI and the toggle must revert.
- On `chrome.runtime.onInstalled`:
  - Pointer unset (fresh install OR upgrade): pin pointer to `"local"`.
  - v2.0.0 removed the v1.4.0 "detect-where-the-config-already-lives"
    branch (sole user, clean break). If you reintroduce multi-user
    support and want graceful upgrades again, restore it from git
    history at tag `v1.6.0`.

### Storage threat model summary

| Threat                                                       | Status |
|--------------------------------------------------------------|--------|
| Other extensions reading our config                          | Blocked (per-extension partitioning). |
| Web pages reading our config via the extension API           | Blocked (no API access). |
| Web pages reading the banner DOM                             | Blocked (closed shadow root). |
| Web pages recovering terms from injected attributes          | Blocked (no `title=`, no `data-*` terms). |
| Web pages enumerating highlighted text via `querySelectorAll`| Mitigated when markers off (CSS Highlight path, no DOM). Visible when markers on (small `__pth_mk__` spans). |
| Local disk reads (other apps, malware, forensics)            | NOT protected. Browser extension storage is unencrypted at rest. |
| Microsoft cloud sync (`storage.sync`)                        | NOT zero-knowledge. Off by default. |
| Exported JSON file                                           | Plaintext. User responsibility. |

### Not yet shipped (would be valuable later)

- AES-GCM passphrase encryption (Web Crypto + PBKDF2). Session-prompted.
- SHA-256 hash-only matching (removes plaintext from storage entirely).
- A real Content Security Policy on the extension pages.

## 5. Highlight engine

Two paths, selected at runtime:

1. **CSS Custom Highlight API path** - used when `cssHighlightsAvailable`
   is true AND the user has disabled the ⚠️ markers
   (`config.highlightMatches === false`). Paints highlights via
   `CSS.highlights` over `Range` objects. **Zero DOM mutation** for the
   matched text. The page cannot find matches via DOM queries.

2. **Span wrapping path** - used in every other case (markers enabled, OR
   browser without CSS Custom Highlight API). Wraps each match in
   `<span class="__pth_hl__">...</span>` and, when markers are enabled,
   appends `<span class="__pth_mk__">⚠️</span>` immediately after.
   This path is the well-tested default that ships behaviour users expect.

In both paths:
- `highlight.add(range)` / `<span>` populates per-term bookkeeping so the
  popup's **Jump** button can `scrollIntoView` (span path) or
  `getBoundingClientRect + window.scrollTo` (CSS path) the Nth occurrence,
  and flash it red.
- Re-scanning is driven by a debounced `MutationObserver`
  (childList + subtree + characterData on `document.body`) so SPAs,
  lazy-loaded sections, and infinite scroll work. Added marker / highlight
  spans are filtered out of the observer to prevent feedback loops.
  Single-page-app route changes are caught by wrapping
  `history.pushState` / `replaceState` and listening to `popstate`.

### Forbidden zones (skip text nodes inside these)

`SCRIPT`, `STYLE`, `NOSCRIPT`, `TEXTAREA`, `INPUT`, `SELECT`, `CODE`,
`PRE`, `IFRAME`, `OBJECT`, `EMBED`, `SVG`, `CANVAS`, and anything inside
`contenteditable`. Also our own shadow host (`__pth_shadow_host__`),
highlight spans, and marker spans.

## 6. Regex / matching rules

- All matching helpers live in **`lib/matching.js`** (`PTHMatching`). They
  are pure functions, deterministic, side-effect free, and are exercised
  by `test/matching.test.js`.
- Case sensitivity is **per term**, not global. A term line starting with
  `cs:` (case-insensitive prefix) is compiled into the case-sensitive
  pool; everything else goes into the case-insensitive pool. The two
  pools become two regexes that are run independently and merged by
  `runScan` (non-overlapping, longest-match-first, `cs` wins ties).
  See §17 for the full v2 contract.
- Terms in each pool are de-duplicated (case-insensitively in the CI
  pool, exactly in the CS pool) and sorted **longest first** before
  being joined with `|`. This guarantees `"BAE Systems"` wins over
  `"BAE"` (JS regex alternation is leftmost-first, not longest-first).
- `wholeWordOnly` wraps each alternation in `\b...\b`. Acknowledged
  limit: `\b` is ASCII-only. Replacing with
  `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])` is a future improvement for
  non-Latin scripts.
- Match counting buckets by the opaque internal key (`ci:<lower>` or
  `cs:<exact>`), so `"BAE"` and `"bae"` in the CI pool count together
  while `"cs:NASA"` stays separate from a hypothetical `"cs:nasa"`.
- `hostMatches`: a hostname matches a pattern when the host **equals**
  the pattern OR ends with `"." + pattern`. The previous `.includes()`
  fallback was removed in v1.5.0 - it was a security footgun (a pattern
  of `google` matched `evil-google.com`). Do not re-add it.
- `sanitizeImportedConfig` enforces a strict allowlist on imported JSON
  configs: unknown top-level keys are dropped, non-string terms are
  rejected, invalid scope kinds / URL-like garbage in hostnames are
  rejected, and hard caps (`LIMITS` constant: `MAX_PROFILE_TERMS=5000`,
  `MAX_PROFILES=500`, plus per-field length caps) prevent absurd
  configs. The options page also caps file imports at 1 MiB.

## 7. Popup, options, badge

- Popup shows the per-term match list for the active tab, with a Jump
  button that cycles through occurrences (`1/3`, `2/3`, ...) and an
  `Aa` badge next to case-sensitive terms.
- Popup also has a **+ Add this page to a profile** button that writes
  a one-shot prefill sentinel
  (`chrome.storage.local.__btw_prefill = { host, scheme, path }`,
  retained verbatim across the v2.1.0 rename - see §18) and
  opens the options page. Options reads + deletes the sentinel on
  `DOMContentLoaded` and appends a new `wholeSite` profile scoped to
  that host. See §17.5.
- The popup talks to the active tab's content script via
  `chrome.tabs.sendMessage({ type: "getMatches" | "scrollToMatch" |
  "rescanNow" })`. If the content script is missing (e.g. on a page that
  loaded before the extension was installed), Rescan re-injects it via
  `chrome.scripting.executeScript`.
- The toolbar badge is set by the background service worker when it
  receives `{ type: "scanResult" }` from the content script. Badge is
  cleared on every navigation start.
- Options page exposes: enabled / whole words only / inline marker /
  storage area radio / per-site profile cards (name + scope dropdown
  with conditional fields + terms textarea) / Export+Import JSON.
  Add/Remove profiles with the buttons; Save runs the result through
  `sanitizeImportedConfig` before writing.

## 8. Versioning and release

- Versions are **semver** in `manifest.json`. The version there is the
  single source of truth.
- Tags are `vX.Y.Z` and **must** match `manifest.json` exactly. The
  release workflow fails if they disagree.
- Every behaviour change ships in its own version bump and Release.
  Trivial README-only edits do not require a bump.
- Tag pushes trigger `.github/workflows/release.yml`, which:
  1. **Pauses for manual approval in the `production` environment** -
     a listed reviewer must click Approve in the GitHub UI before the
     job runs. The environment is also restricted to `refs/tags/v*`.
  2. Resolves version from the tag (or `workflow_dispatch` input).
  3. Verifies it matches `manifest.json`.
  4. Runs `node --test test/*.test.js`.
  5. `rsync`s a clean staging tree excluding `.git`, `.github`, `dist`,
     `staging`, `test`, `AGENTS.md`, `SECURITY.md`, `README.md`,
     `LICENSE`, `.gitignore`.
  6. Zips to `dist/edge-page-term-highlighter-<version>.zip`.
  7. Generates a `.zip.sha256` checksum.
  8. Creates a GitHub Release with both files and install instructions.
- `.github/workflows/validate.yml` runs on every push/PR: validates the
  manifest, `node --check`s every JS file (including `lib/config.js`),
  and dry-runs the packaging.

### Releasing a new version

```bash
# 1. Edit manifest.json -> bump "version"
# 2. Edit code / docs
git add -A
git commit -m "Release vX.Y.Z: <one-line summary>"
git tag vX.Y.Z
git push origin main --tags
# Release workflow runs automatically. Wait for it, verify the assets
# appear on the Releases page.
```

Or run **Actions -> Release Extension -> Run workflow** and supply the
version.

### Update instructions communicated to users

1. Download `edge-page-term-highlighter-<version>.zip` from the GitHub
   Release.
2. Extract over the existing extension folder.
3. Open `edge://extensions/`, click the reload (↻) icon on the extension
   card.

## 9. Schema + config-shape discipline

- v2.0.0 made a deliberate clean break from the v1.x schema (sole user,
  no migration). The new shape is documented in §17.1 and carries
  `schemaVersion: 2`. If the schema needs to evolve **again**, decide
  up-front whether to (a) bump `schemaVersion` and add a migration in
  `PTHConfig.getConfig` / `background.js#onInstalled`, or (b) repeat
  the clean-break approach if there are still no third-party users.
- `PTHConfig.getConfig()` always returns either `null` or the saved
  object. Callers `Object.assign({}, PTHMatching.DEFAULT_CONFIG, config || {})`
  so missing top-level keys fall back to defaults.
- **Single source of truth for defaults**: `PTHMatching.DEFAULT_CONFIG`
  (frozen) in `lib/matching.js`. `background.js` seeds first-install
  storage with it; `options.js` back-fills the form with it;
  `sanitizeImportedConfig` validates against it.
- When the storage area changes, every consumer must re-read via
  `PTHConfig.getConfig()` (already wired via `onConfigChanged`).

## 10. Coding conventions

- Pure ES2020 vanilla JS. No transpilation.
- Use `\uXXXX` literals for emoji in source (`"\u26A0\uFE0F"`) to avoid
  encoding surprises across editors and CI runners.
- Inline `Object.assign(el.style, {...})` instead of CSS string concat -
  easier to read in 280-char popup widths.
- Defensive: every async function that touches storage should tolerate
  `null` / `undefined`.
- Wrap `chrome.runtime.sendMessage` in `try {}` - it throws when no
  receiver is registered (common on tabs the content script doesn't run
  on, e.g. `chrome://` pages).
- Public IDs / class names on injected DOM use the `__pth_*` prefix.
  Never include the configured term in the DOM as data.

## 11. Edge Add-ons store (not yet submitted)

If/when we publish to the official store:

- Register a (free) developer account at Partner Center.
- Provide a privacy policy URL (required because of `<all_urls>` host
  permission). It must state: "no data is collected or transmitted; all
  configuration stays in the browser's local extension storage".
- Reviewer notes must explain `<all_urls>` (needed to scan every page's
  visible text against the user-configured terms).
- Store listing assets: 300×300 logo, ≥1 screenshot 1280×800.
- Bump `manifest.json` version for every submission - duplicate versions
  are rejected.
- After acceptance, link the store page from the README and add a
  one-click install option above the developer-mode instructions.

## 12. Branding / wording

- Browser-vendor-agnostic where possible. Prefer "your browser account"
  over "your Microsoft account" in user-facing text, because the same
  package runs in Chrome / Brave / Edge.
- Lead with **local-first / privacy-first** in the README. `storage.sync`
  is described as opt-in, never as the default.
- Badges: Validate + Release workflow badges are served by GitHub directly
  and are reliable. The "latest release" badge uses **badgen.net**, not
  shields.io, because shields.io periodically returns "Unable to select
  next GitHub token from pool" when their auth pool is exhausted.

## 13. Open follow-ups

These are valuable, not yet built:

1. **`block` severity per profile** - interstitial page with Back / Continue.
2. **Regex support via `re:` prefix** on individual terms.
3. **Right-click "Add selection to a profile"** context-menu.
4. **Unicode word boundaries** for `wholeWordOnly`.
5. **AES-GCM passphrase encryption** of the stored config.
6. **Hash-only matching** (SHA-256 of each term).
7. **Edge Add-ons store submission**.
8. **Subresource Integrity / signed releases** (cosign / Sigstore).

## 14. Security hardening shipped in v1.5.0

These are the cross-cutting changes that landed together; do not regress
them without an explicit conversation.

- Strict **Content Security Policy** on extension pages
  (`script-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'none'`).
- `minimum_chrome_version: "111"` to guarantee the CSS Custom Highlight
  API and other modern primitives are present.
- Pure helpers extracted to **`lib/matching.js`** and unit tested.
- **`sanitizeImportedConfig`** strict allowlist + size caps for imported
  JSON; 1 MiB file-size cap in the options page.
- **`hostMatches` substring-fallback removed** - it matched
  `evil-google.com` against `google`.
- **`renderRule` in options.js** rewritten with `createElement` /
  `textContent` only; no `innerHTML` templating.
- **Service-worker message handler** checks `sender.id === chrome.runtime.id`
  and `sender.tab` before acting; ignores anything else.
- **`lib/config.js` comment** corrected to match the code's local-first
  default.
- **GitHub Actions pinned by commit SHA** (not moving tags),
  `step-security/harden-runner` audits egress, **`permissions:
  contents: write`** only on release (read-only on validate/codeql),
  workflows have `timeout-minutes`, the release script validates the
  version with a regex before string-substituting it.
- **Dependabot** configured for weekly Action updates.
- **CodeQL** JavaScript SAST workflow added (push + PR + weekly cron).

## 15. Features shipped in v1.6.0

> **Superseded by §17 (v2.0.0).** The acronym-mode config fields
> (`globalCsTerms`, per-rule `csTerms`) and the v1.x global / per-rule /
> disabled-hosts model described below were removed in v2.0.0. The
> popup ↔ content `scanResult` / `getMatches` / `scrollToMatch` protocol
> (§15.1 final bullet) and the visibility + removal reconciliation
> (§15.2) were carried over to v2.0.0 unchanged and are still current.
> Keep this section for historical context only.

Two cross-cutting changes landed together in v1.6.0.

### 15.1 Acronym mode (per-list case sensitivity)

- **New config fields**: top-level `globalCsTerms` (string[]) and
  per-rule `csTerms` (string[]). Terms in these lists are **always**
  matched case-sensitively regardless of the global `caseSensitive`
  flag. Useful for `NASA` / `API` / `BAE` which should not match
  `nasa` / `api` / `bae` in ordinary prose.
- **Backward compatibility**: `sanitizeImportedConfig` and
  `sanitizeSiteRules` default missing `globalCsTerms` / `csTerms` to
  `[]` so pre-1.6 configs and JSON imports keep working unchanged. No
  storage migration was needed.
- **Pure-helper contract** in `lib/matching.js`:
  - `buildScanContext({ terms, csTerms, caseSensitive, wholeWordOnly })`
    returns `{ regexCI, regexCS, caseSensitive, wholeWordOnly,
    displayByKey, hasAny }`. `regexCI` honours the global flag;
    `regexCS` is hard-wired to case-sensitive.
  - `runScan(text, ctx)` runs both regexes, sorts by (start asc, length
    desc, CS-wins-tie), and emits non-overlapping matches each tagged
    with an opaque internal `key` of the form `ci:<lower>` or
    `cs:<exact>`.
  - `keyForMatch(pool, text, caseSensitive)` is the canonical key
    builder. Internal keys are the source of truth for bookkeeping,
    popup payload, and `scrollToMatch`. UI never displays the prefix.
- **Display preservation**: `ctx.displayByKey` maps internal key →
  user-originally-typed term so the popup shows what the user typed,
  not the lowercased / matched form.
- **Popup contract**: the `scanResult` and `getMatches` payload is now
  `[{ key, term, count, cs }]`. The popup renders a small `Aa` badge
  next to any entry where `cs === true`. `scrollToMatch` accepts
  `{ key, index }` (was `{ term, index }`). Both popup and content
  ship in v1.6.0 so there is no in-flight protocol mismatch.

### 15.2 Visibility + removal reconciliation

- **The problem fixed**: in v1.5.x, if a matched node was removed
  (SPA tab swap, virtual scroll, "Load more" replacing a section) or
  hidden (`display:none`, `visibility:hidden`, `[hidden]`,
  `[aria-hidden="true"]`), the bookkeeping kept counting it. Badge,
  popup, and banner all reported phantom matches.
- **The fix**: `content.js` now runs a debounced **reconciliation
  pass** triggered by either (a) `removedNodes` in a `childList`
  mutation, or (b) any attribute change matching the filter
  `["hidden", "aria-hidden", "style", "class"]`. The observer config
  is extended with `attributes: true, attributeFilter: [...]` for case (b).
- **`isEffectivelyVisible(node)`** walks ancestors up to `<body>` and
  returns false if any ancestor is `[hidden]`, has
  `aria-hidden="true"`, or has computed `display:none` /
  `visibility:hidden|collapse`. Opacity and offscreen scroll are
  deliberately **not** treated as hidden (stylistic / transient).
- **Pure-helper contract**: `reconcileBookkeeping(book, isLive)` drops
  dead entries from a Map<key, entry[]>, removes empty keys, and
  returns `{ changed, matchCounts }`. Extracted so reconcile can be
  unit-tested without JSDOM.
- **CSS-Highlight registry cleanup**: dead `Range` objects are also
  evicted from the live `Highlight` so the page paints nothing where
  the match no longer exists.
- **Popup live updates**: the popup listens on
  `chrome.runtime.onMessage` for `scanResult` messages whose
  `sender.tab.id === currentTabId` and re-renders in place. This makes
  the count drop the moment the user clicks the tab that hides the
  match - no rescan needed.

### 15.3 What was deliberately NOT done

- **Tier B IntersectionObserver per match** was scoped out. The Tier A
  ancestor walk catches every common tab/accordion pattern at much
  lower memory cost. If a user reports a case Tier A misses
  (scrolled-offscreen virtualised list where the entry is still in the
  DOM but visually clipped), revisit Tier B behind a Settings toggle.
- **Per-pool MAX_TERMS** stays at 5000 per list (so theoretical max is
  10K combined per scope). The 1 MiB import file cap bounds total
  absolute size.

## 16. What an agent should do before committing

1. `node --test test/*.test.js` - all tests must pass. (Don't use
   `node --test test/` - Node 22.22+ interprets the bare directory as a
   module path and fails.)
2. `node --check` every modified `.js` file.
3. Load the extension via **Load unpacked** in Edge and confirm:
   - On a page covered by a profile: banner appears, inline ⚠️ marker
     appears beside each match (when the marker is enabled), popup
     match list populates, **Jump** scrolls and flashes, `Aa` badge
     appears next to `cs:` terms.
   - On a page with no matching profile: nothing happens - no banner,
     no badge, no console output. (Use the popup's **+ Add this page
     to a profile** button to create one in one click.)
   - Toggling storage area in Settings migrates config and the popup
     still shows matches afterwards.
   - `edge://extensions/` shows no console errors from background or
     content script.
4. Bump `manifest.json` version if behaviour changed.
5. Update README / AGENTS.md if the user-facing model or developer
   workflow changed.
6. Commit with a clear, scoped message; tag and push when ready to ship.

## 17. v2.0.0 redesign (current model)

v2.0.0 supersedes the v1.x configuration model. The pre-1.6 acronym-mode
shape described in §15.1 and the per-rule UI patterns described in §15
were **removed**, not extended. There is no migration code (sole user).

### 17.1 Schema

```
{
  schemaVersion: 2,
  enabled: boolean,
  wholeWordOnly: boolean,
  highlightMatches: boolean,
  profiles: [
    {
      id: string,                 // generated via crypto.randomUUID()
      name: string,               // free-form label
      scope: Scope,               // see 17.3
      terms: string[]             // each line either "term" or "cs:term"
    }
  ]
}
```

The global `caseSensitive` flag, `globalTerms`, `globalCsTerms`,
`siteRules`, `disabledHosts`, and per-rule `csTerms` are all gone. Case
sensitivity is now expressed **per term** via the `cs:` line prefix
(see `PTHMatching.CS_PREFIX`).

### 17.2 Terms (cs: prefix)

- `parseTermLine(line)` is the canonical parser. The `cs:` prefix is
  case-insensitive (`CS:NASA` works) and is stripped before storage.
- `splitTermPools(rawTerms)` returns `{ ci, cs }`: two arrays the
  scanner compiles into separate regexes. CI pool dedupes
  case-insensitively; CS pool dedupes by exact case.
- `sanitizeTermList(arr)` is the canonical write-back form (cs:
  prefix re-attached, lines re-trimmed, capped at
  `LIMITS.MAX_PROFILE_TERMS = 5000`).

### 17.3 Scope kinds

Six canonical kinds in `PTHMatching.VALID_SCOPE_KINDS`. All shapes are
JSON-safe; regex caches are built lazily on `scope.__pathRegex` inside
`scopeMatchesUrl`.

| kind          | shape                                                         | match rule |
|---------------|---------------------------------------------------------------|------------|
| `anyUrl`      | `{ kind }`                                                    | any parseable URL |
| `wholeSite`   | `{ kind, host }`                                              | http/https + host equals or ends with `.host` |
| `hostOnly`    | `{ kind, host }`                                              | http/https + host equals (no subdomains) |
| `pathPrefix`  | `{ kind, host, path }`                                        | wholeSite-style host + path starts with prefix at a directory boundary (`/`, `?`, `#`) |
| `exactUrl`    | `{ kind, scheme, host, path }`                                | scheme + host + path all equal |
| `matchPattern`| `{ kind, pattern, scheme, host, includeSubdomains, path }`    | Chromium subset: `(*|https?)://(\*|*.host|host)/path` with `*` only in path |

`<all_urls>` literal is NOT accepted - users pick `anyUrl` instead.

### 17.4 Opt-in by site

`manifest.json` keeps `<all_urls>` content_script registration for
zero-prompt installation. `content.js` reads `profilesForUrl(profiles,
location.href)` at the top of `run()` and returns immediately if the
list is empty - no banner, no observer, no badge, no listeners beyond
the runtime message handler. Net effect: the extension behaves as if
it were opt-in by site, without re-prompting the user for optional
host permissions on every new site.

### 17.5 "Add this page" handoff

Popup writes a one-shot prefill sentinel:

```
chrome.storage.local.set({ __btw_prefill: { host, scheme, path } })
chrome.runtime.openOptionsPage()
```

Options reads + deletes the sentinel on `DOMContentLoaded`, appends a
new profile scoped `{ kind: "wholeSite", host }`, scrolls to it, and
focuses the terms textarea. Sentinel lives only in
`chrome.storage.local` (never in `sync`).

### 17.6 Popup ↔ content protocol (unchanged from v1.6.0)

- `scanResult` / `getMatches` payload: `[{ key, term, count, cs }]`
  where `key` is `"ci:<lower>"` or `"cs:<exact>"`.
- `scrollToMatch` accepts `{ key, index }`.
- Popup renders `Aa` badge when `cs === true`.

### 17.7 Tests + limits

- `test/matching.test.js` rewritten for v2 (66 passing, includes
  `test/config.test.js`'s 7). Add new tests in the same style.
- `LIMITS` (frozen): `MAX_TERM_LENGTH: 200`, `MAX_PROFILE_TERMS: 5000`,
  `MAX_PROFILES: 500`, `MAX_NAME_LENGTH: 120`, `MAX_HOST_LENGTH: 253`,
  `MAX_PATH_LENGTH: 2048`, `MAX_PATTERN_LENGTH: 2048`.
- `SCHEMA_VERSION = 2`, `CS_PREFIX = "cs:"`.

### 17.8 What was deliberately NOT done

- No automatic migration from v1.x configs. Sole user; deleted in place.
- No per-host disable. Users delete or rename the profile instead.
- No regex-prefix support yet (see §13.2 follow-up).

## 18. v2.1.0 rename (Banned Terms Warning -> Page Term Highlighter)

v2.1.0 was a pure rebrand. No schema change, no migration, no behaviour
change. The GitHub repo was renamed from `edge-banned-terms-warning` to
`edge-page-term-highlighter` (`gh repo rename`; old URL still redirects),
the product name in `manifest.json` / popup / options / banner was
updated, and the JS / DOM namespaces were renamed:

| Before               | After                |
|----------------------|----------------------|
| `BTWConfig`          | `PTHConfig`          |
| `BTWMatching`        | `PTHMatching`        |
| `__btw_hl__`         | `__pth_hl__`         |
| `__btw_mk__`         | `__pth_mk__`         |
| `__btw_shadow_host__`| `__pth_shadow_host__`|
| `__btw_hl_style__`   | `__pth_hl_style__`   |
| `btw-match` / `btw-match-flash` | `pth-match` / `pth-match-flash` |
| `__bannedTermsScanRan` etc. window flags | `__pthScanRan` etc. |
| Banner: "Banned content warning" | Banner: "Highlighted terms detected" |
| ZIP: `edge-banned-terms-warning-*.zip` | ZIP: `edge-page-term-highlighter-*.zip` |

**Deliberate exception**: the one-shot prefill sentinel storage key
`chrome.storage.local.__btw_prefill` (§17.5) was kept verbatim. It is a
transient handoff value written by the popup and deleted by the options
page on read; never user-visible. Renaming it would have required either
a migration shim or losing any in-flight prefill on the upgrade. Since
it has zero user impact, the legacy name stays.

Storage keys `config` and `storageArea` were also unchanged, so existing
settings survive the upgrade with no migration code.
