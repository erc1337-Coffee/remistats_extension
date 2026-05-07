# RemiStats Extension

A browser extension that overlays [RemiStats](https://remistats.net) reputation scores on X.com (Twitter) profiles, tweets, and user lists.

The extension reads the username from any rendered tweet, user cell, or profile header and fetches the corresponding social credit score, beetle count, and PFP from the RemiStats API. Scores appear inline as a small badge with a hover tooltip showing the full breakdown.

## Install (development)

1. Clone this repository.
2. Open `chrome://extensions` (or the equivalent in any Chromium-based browser).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the cloned directory.

The extension activates on `https://x.com/*` and `https://twitter.com/*`.

## Build

There is no build step. The `manifest.json` and source files at the repo root are loaded directly by the browser.

To package for the Chrome Web Store, zip the entire repository (excluding `.git/`, `.gitignore`, and any local cruft):

```bash
zip -r remistats.zip . -x '.git/*' '.gitignore' '.DS_Store' '*.zip'
```

## API

The extension calls `https://api.remistats.net/user/<username>[,<username>...]` for batched score lookups. The API serves public reputation data only; the extension sends no authentication and no personal data.

## Permissions

| Permission              | Why                                                              |
| ----------------------- | ---------------------------------------------------------------- |
| `storage`               | Persist user preferences (tooltips, sounds) via `chrome.storage` |
| `activeTab`             | Required to attach badges to the active X.com tab                |
| `https://x.com/*`       | Inject the content script that renders badges                    |
| `https://twitter.com/*` | Same, for the legacy domain                                      |

No other host permissions, no `<all_urls>`.

## License

See [LICENSE](./LICENSE).
