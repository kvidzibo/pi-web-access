# pi-web-access

Pi package. Keyless web search + local URL fetch.

No GitHub clone, PDF, video, curator UI, or API keys.

| tool | job |
|---|---|
| `web_search` | Exa MCP, DuckDuckGo HTML fallback |
| `fetch_content` | this machine GETs the URL, Readability → markdown |
| `get_search_content` | page/find cached full text |

> **Security:** Pi packages run with your full system permissions. `fetch_content` hits the public internet from this machine. A local SSRF gate blocks private/loopback/link-local IPs, URL credentials, and non-http(s). Install only from a source you trust.

## Install

Git (after the repo is published):

```bash
pi install git:github.com/kvidzibo/pi-web-access@v0.1.0
```

Local checkout:

```bash
pi install /absolute/path/to/pi-web-access
```

Needs Pi on PATH. `pi install` runs `npm install` for runtime deps (`@mozilla/readability`, `linkedom`, `turndown`). Pi supplies `@earendil-works/*` and `typebox`.

Do **not** also list this path in `settings.json` `extensions` — package load is enough.

Then `/reload` (or restart Pi).

## Cache

`~/.pi/agent/web-access-cache` (0700 / 0600, 1h, 128 entries, 128 MiB).

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live network in the default suite. Optional smoke:

```bash
WEB_ACCESS_LIVE=1 node --test --experimental-strip-types tests/live.test.ts
```

## Publish

- GitHub: `kvidzibo/pi-web-access` (not pushed yet)
- npm: `@kvidzibo/pi-web-access` (gallery crawls the `pi-package` keyword; not published yet)
