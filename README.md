# Banned Terms Warning - Microsoft Edge Extension

[![Validate](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/validate.yml/badge.svg)](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/validate.yml)
[![Release](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/release.yml/badge.svg)](https://github.com/guypritchard/edge-banned-terms-warning/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/guypritchard/edge-banned-terms-warning?display_name=tag&sort=semver)](https://github.com/guypritchard/edge-banned-terms-warning/releases/latest)

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

- A content script runs at `document_idle` on every page, reads `document.body.innerText`, and tests it against a single combined regex built from your global terms plus any matching per-site rule terms.
- If matches are found, a fixed-position red banner is injected at the top of the page (and removed on user click).
- The background service worker sets the toolbar badge to the total number of distinct matched terms for that tab.
- Configuration is read from `chrome.storage.sync`; changes take effect on the next page load (or click **Rescan tab** in the popup).

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
