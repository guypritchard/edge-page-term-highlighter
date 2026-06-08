# Security policy

Thank you for taking the time to report a vulnerability.

## Supported versions

Only the **latest published release** receives security fixes. Older
releases are not patched - please upgrade.

See [Releases](https://github.com/guypritchard/edge-page-term-highlighter/releases/latest).

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/guypritchard/edge-page-term-highlighter/security/advisories/new).

If for any reason you cannot use that form, email
`guy.pritchard@users.noreply.github.com` with:

- A description of the issue and its impact.
- Reproduction steps (or a proof-of-concept extension config / page).
- The version of the extension you tested against (from
  `edge://extensions/`).
- Your preferred name / handle for credit (optional).

You should receive an acknowledgement within **5 working days**. If you do
not, please follow up - the email may have been filtered.

## Scope

In scope:

- The extension code shipped in any release ZIP (`manifest.json`,
  `background.js`, `content.js`, `popup.*`, `options.*`, `lib/*`).
- The GitHub Actions workflows in `.github/workflows/`.
- The repository's release / build pipeline.

Out of scope (please do not report):

- Issues that require physical or local-machine access to the user's
  device (this is acknowledged in `README.md` under "Residual risks").
- Self-XSS in `chrome://extensions/` developer tools.
- Theoretical attacks that require the user to install an unrelated
  malicious extension first.
- Vulnerabilities in third-party browsers (report to the browser vendor).

## What we'll do

1. Confirm the report and assess severity.
2. Develop and test a fix in a private branch.
3. Publish a release with the fix.
4. Publish a security advisory crediting the reporter (unless you
   prefer otherwise).
5. Disclose responsibly. We do not currently offer a bug bounty.

## Security hardening already in place

See `AGENTS.md` section 14 for the full list. Highlights:

- Strict Content Security Policy on extension pages.
- All imported JSON config is sanitised against a strict allowlist.
- Closed Shadow DOM banner (page scripts cannot read it).
- Service worker and content script verify `sender.id` on every message.
- All third-party GitHub Actions are pinned by commit SHA.
- `step-security/harden-runner` audits runner egress.
- Least-privilege `GITHUB_TOKEN` (`contents: write` only on the release
  job; read-only elsewhere).
- Branch + tag protection rulesets prevent force-push, deletion, and
  history rewrites on `main` and any `v*` tag.
- CodeQL JavaScript static analysis on every push, PR, and weekly.
- Dependabot vulnerability alerts + automated security updates enabled.
- Private vulnerability reporting enabled.
