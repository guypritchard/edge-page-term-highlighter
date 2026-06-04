# Banned Terms Warning - Microsoft Edge Extension

[![Validate](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/validate.yml/badge.svg)](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/validate.yml)
[![Release](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/release.yml/badge.svg)](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/release.yml)
[![Latest Release](https://badgen.net/github/release/guypritchard/edge-banned-terms-warning/stable)](https://github.com/guypritchard/edge-banned-terms-warning/releases/latest)

A Microsoft Edge / Chromium browser extension (Manifest V3) that scans the visible text of every page you load and shows a red ⚠️ warning banner at the top when any of your configured **banned terms** appear. Supports **global terms**, **per-site rules**, and **per-site disabling**.

> 100% local. No data leaves your browser. Configuration is stored in `chrome.storage.sync` and follows your Edge profile across devices.

---

## Features

- ⚠️ Dismissible red banner at the top of any page containing matched terms
- 🔢 Toolbar badge showing the number of distinct matches on the active tab
- 🌐 **Global** banned terms list
- 🎯 **Per-site rules** - extra terms that only fire on specific hostnames (and subdomains)
- 🚫 **Per-site disable** - skip scanning entirely on chosen hosts
- 🔠 Case-sensitive and whole-word matching toggles
- 💾 Import / Export configuration as JSON
- 🔒 Zero telemetry, no remote calls, no analytics

---

## Install (Developer Mode)

The extension is not (yet) published to the Edge Add-ons store. Install from a GitHub release:

1. Go to the [**Releases**](https://github.com/guypritchard/edge-banned-terms-warning/releases/latest) page.
2. Download the latest `edge-banned-terms-warning-<version>.zip`.
3. **Extract** the ZIP to a folder you'll keep around (Edge loads the extension from disk - if you delete or move it, the extension breaks).
4. Open Edge and navigate to `edge://extensions/`.
5. Toggle **Developer mode** on (bottom-left of the page).
6. Click **Load unpacked** and select the **extracted folder** (not the zip).
7. Pin the extension to the toolbar via the puzzle-piece menu (optional).
8. Click the extension icon -> **Settings** to configure your banned terms.

> The same package also works in Google Chrome, Brave, Opera, and other Chromium browsers via `chrome://extensions/`.

### Updating

When a new release is published:

1. Download the new ZIP from Releases.
2. Extract over the existing folder (or to a new folder).
3. On `edge://extensions/`, click the **reload** (↻) icon on the extension card.

---

## Configuration

Open the **Settings** page (right-click extension icon -> *Extension options*, or popup -> *Settings*).

| Setting | Description |
|---|---|
| **Extension enabled** | Master on/off switch. |
| **Case sensitive** | When off, "Foo" matches "foo", "FOO", etc. |
| **Whole words only** | When on, "cat" won't match inside "category". |
| **Global banned terms** | One term/phrase per line. Applies to every page. |
| **Disabled sites** | Hostnames where scanning is skipped (e.g. `mail.google.com`). |
| **Per-site rules** | Hostname pattern + extra terms that only trigger on that host or its subdomains. |
| **Export / Import JSON** | Back up or share configuration between machines. |

### Hostname matching

A pattern matches if the page's hostname:

- equals the pattern (`example.com` matches `example.com`), or
- ends with `.` + the pattern (`example.com` matches `www.example.com`, `news.example.com`), or
- contains the pattern as a substring (`example` matches `myexample.org`).

Use the most specific pattern you can (`reddit.com` rather than just `reddit`).

### Example configuration

```json
{
  "enabled": true,
  "caseSensitive": false,
  "wholeWordOnly": true,
  "globalTerms": ["confidential", "internal use only"],
  "disabledHosts": ["mail.google.com"],
  "siteRules": [
    { "pattern": "reddit.com",   "terms": ["spoiler"] },
    { "pattern": "news.ycombinator.com", "terms": ["acquired", "shutdown"] }
  ]
}
```

You can paste this directly into the **Import JSON** button on the Settings page.

---

## How it works

- A content script runs at `document_idle` on every page, walks text nodes under `<body>`, and either:
  - Uses the **[CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)** (`CSS.highlights`) to paint the highlight without mutating the DOM (Edge / Chrome 105+, the default path), or
  - Falls back to wrapping each match in a `<span>` on older engines.
- A `MutationObserver` re-scans newly added subtrees as the page loads/changes (SPAs, infinite scroll, lazy-loaded content). `pushState`/`replaceState`/`popstate` trigger a full re-scan.
- The banner is rendered inside a **closed Shadow DOM** so page scripts cannot read it via `document.querySelector`.
- Configuration is loaded via the shared helper in `lib/config.js`, which reads from either `chrome.storage.sync` or `chrome.storage.local` depending on the user's choice.

---

## Security model

This extension stores your banned-terms list in your browser's extension storage and (optionally) paints highlight markers on web pages. Here is what is and isn't protected.

### Protected against

- **Other extensions reading your config.** Each extension's storage is partitioned by extension ID.
- **Web pages reading the extension API.** Pages cannot access `chrome.storage`.
- **Web pages reading the warning banner.** The banner is rendered inside a **closed shadow root** (`mode: "closed"`), so `document.querySelector` / `getRootNode()` returns nothing.
- **Web pages enumerating the highlighted text on the page.** With the CSS Custom Highlight path (default on modern Edge/Chrome), there is **no DOM mutation** for the highlight - matches are painted via `::highlight()` ranges. The page cannot find them with `querySelectorAll`, cannot read attributes, and cannot pull the configured term list out of the DOM.
- **Web pages exfiltrating the configured term list from injected markers.** Marker spans (⚠️) carry no `title=` and no `data-*` attributes containing terms.

### Residual risks

- **Visible-extension presence.** If markers are enabled, the page sees a `<span class="__btw_mk__">⚠️</span>` next to each match. The page can count these but learns nothing about which words triggered them, nor any other configured term. Disable markers in Settings if you want zero visible-extension fingerprint.
- **Local-machine access.** Anyone who can read your Edge profile (other apps you run, malware, forensic tools, an admin with disk access) can read the LevelDB store under `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Local Extension Settings\<extension id>\`. Browser extension storage is not encrypted at rest.
- **DevTools** on your own machine reads everything by design.
- **Exported JSON** is plaintext on disk - treat it like any other secret.

### Cloud sync (`chrome.storage.sync`) vs local (`chrome.storage.local`)

The Settings page lets you choose:

| Storage | Cross-device sync | Visible to Microsoft (cloud) | Quota |
|---|---|---|---|
| `chrome.storage.local` (default) | No | No - never leaves the device | ~10 MB |
| `chrome.storage.sync` | Yes (via your MS account) | Yes - TLS in transit, MS-encrypted at rest, but **MS holds the key** | ~100 KB total, 8 KB per item |

Switching areas in Settings migrates your existing configuration automatically. If you have a large config saved in `local` and switch back to `sync`, the move can fail with a quota error - the UI will report it and revert.

> New installs default to `local`. If you are upgrading from v1.4.0 or earlier, the extension keeps using whichever area already held your config so nothing changes silently.

### Further hardening not yet shipped

If your threat model demands more:

1. **Passphrase-encrypted config** - AES-GCM with a PBKDF2-derived key, prompted on session start. Lose the passphrase, lose the config.
2. **Hash-only matching** - store SHA-256 hashes of each term and match by hashing tokenised words from the page. Removes plaintext from storage entirely at the cost of phrase/regex flexibility.

Open an issue if you want either of those prioritised.

---

## Project structure

```
.
├── manifest.json          # MV3 manifest
├── background.js          # Service worker (badge + messaging)
├── content.js             # Page scanner + banner UI
├── popup.html / popup.js  # Toolbar popup
├── options.html / options.js  # Settings page
├── icons/                 # 16/48/128 px icons
└── .github/workflows/
    ├── validate.yml       # PR / push validation
    └── release.yml        # Builds & publishes a Release ZIP on tag
```

---

## Releasing a new version

Releases are produced automatically by the [Release Extension](.github/workflows/release.yml) workflow.

**Option A - Git tag:**

```bash
# 1. Bump the version in manifest.json (must be semver, e.g. 1.0.1)
# 2. Commit, then tag and push:
git commit -am "Release v1.0.1"
git tag v1.0.1
git push origin main --tags
```

**Option B - Manual dispatch:**

GitHub -> **Actions** -> **Release Extension** -> **Run workflow** -> enter the version (e.g. `1.0.1`).

The workflow:

1. Verifies the version in `manifest.json` matches the tag / input.
2. Packages a clean ZIP excluding `.git`, `.github`, README, etc.
3. Generates a SHA-256 checksum.
4. Publishes a GitHub Release with the ZIP, the checksum, and install instructions.

---

## Publishing to the Edge Add-ons Store

See the steps in the [release notes](https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/publish-extension). Summary:

1. Register a (free) developer account at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/registration).
2. Bump `manifest.json` version and download the latest release ZIP.
3. Create a new extension submission, upload the ZIP, fill out the store listing (logo 300×300, screenshot 1280×800, privacy policy URL, description).
4. Submit for certification (24-72 hrs typical).

---

## Contributing

Issues and PRs welcome. Please:

- Run a smoke test in Edge with **Load unpacked** before submitting.
- Keep dependencies at **zero** - this extension is intentionally vanilla JS/HTML/CSS.
- Don't add network calls. Privacy is the point.

---

## License

[MIT](LICENSE)
