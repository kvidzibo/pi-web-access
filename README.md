# pi-web-access

Search the web, fetch pages as Markdown and inspect cached results from the [Pi coding agent](https://github.com/earendil-works/pi), without supplying search API keys. Revisit long results in chunks or find a passage without fetching the page again.

No GitHub clone, PDF, video or curator UI.

| tool | job |
|---|---|
| `web_search` | Exa MCP, DuckDuckGo HTML fallback |
| `fetch_content` | this machine GETs the URL, Readability → markdown |
| `get_search_content` | page/find cached full text |

> **Security:** Pi packages run with your full system permissions. Search and content requests hit the public internet from this machine. A local SSRF gate blocks private/loopback/link-local/special-use IPs, URL credentials, and non-http(s), rechecks every redirect, and pins DNS lookup to the connecting socket (no second resolve). Install only from a source you trust.

## Quick example

After [installing](#install), ask Pi:

```text
Search nodejs.org for the Node.js test runner documentation.
Fetch the relevant documentation page as Markdown, then use
get_search_content with the fetch responseId to find "node --test".
Include the source URL in your answer.
```

The tool sequence is **search → fetch → inspect the cached text**:

1. `web_search`:

   ```json
   {
     "query": "Node.js test runner documentation",
     "domainFilter": ["nodejs.org"],
     "numResults": 3
   }
   ```

2. `fetch_content`, using a relevant result URL (for example):

   ```json
   { "url": "https://nodejs.org/api/test.html" }
   ```

3. `get_search_content`, using the ID returned by that fetch:

   ```json
   { "responseId": "REPLACE_WITH_FETCH_RESPONSE_ID", "findText": "node --test" }
   ```

Replace the placeholder with the actual `responseId`. These are example arguments, not captured results. Search and fetch need public network access; the final lookup reads the local cache, whose entries expire after one hour. Provider availability and limits still apply even without API keys.

**Design trade-off:** HTTP fetching and Readability extraction avoid launching a browser, but do not execute page JavaScript. Use [pi-browser](https://github.com/kvidzibo/pi-browser) when content needs interaction or rendering. See [fetch handling](fetch.ts), [HTML extraction](html.ts) and [extraction tests](tests/html.test.ts).

## Install

This README tracks repository source. npm packages and Git tags may be behind it; check the version you install before relying on newer features.

```bash
pi install npm:@kvidzibo/pi-web-access
```

Git:

```bash
pi install git:github.com/kvidzibo/pi-web-access@v0.1.0
```

Local checkout — Pi adds the path only; it does **not** run `npm install` for local sources:

```bash
cd /absolute/path/to/pi-web-access
npm install --omit=peer
pi install /absolute/path/to/pi-web-access
```

`pi install` of **npm or git** sources runs `npm install` for runtime deps (`@mozilla/readability`, `linkedom`, `turndown`). Pi supplies `@earendil-works/*` and `typebox`.

Do **not** also list this path in `settings.json` `extensions` — package load is enough.

Then `/reload` (or restart Pi).

## HTTP handling

- Unsupported final HTTP status codes (outside 200–599), protocol upgrades, and response-conversion failures become request errors instead of terminating Pi. `HEAD`, `204`, `205`, and `304` responses have no body.
- Gzip, deflate, and Brotli are decoded as streams (up to three stacked encodings). The 2,000,000-byte response limit applies **after decoding**. Invalid encodings and truncated bodies are errors; unused streams are canceled.
- The 30-second request timeout and cancellation include waiting for DNS. A canceled lookup cannot start an HTTP connection afterward.
- Redirects discard cross-origin credentials and stale Host headers. POST-to-GET redirects also discard the body and its headers; HEAD remains HEAD on a 303.

Readable Markdown resolves relative links and image sources against the final fetched URL, including a valid HTML `<base>` element. Fragment anchors and non-HTTP links remain links only; extraction never fetches them.

## Search and errors

Domain filters are sent to both providers and enforced on returned URLs; multiple allowed domains use OR. DuckDuckGo uses its date filter for `recencyFilter`; Exa receives a relative-date query hint, not a guaranteed date constraint. Empty matching results are identified explicitly.

A failed query no longer discards successful queries from the same batch. A provider timeout ends that query without fallback; later queries still run. Caller cancellation stops the batch and does not cache canceled results. All-failed batches and invalid tool arguments throw errors as required by Pi; partial results remain available. All-failed batch errors include a cache response ID for inspection with `get_search_content`.

## Cache

`~/.pi/agent/web-access-cache` (dir 0700, files 0600). Entries expire after 1 hour. Expired and over-quota files are deleted when the extension loads and on store/get. Inactive leftover files can remain until the next load.

Caps: 128 entries, 128 MiB. Case-insensitive and fuzzy match offsets refer to the original UTF-16 text, even when Unicode lowercasing changes its length.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

The default suite uses fixtures and loopback servers, never the public network. Optional live smoke:

```bash
WEB_ACCESS_LIVE=1 node --test --experimental-strip-types tests/live.test.ts
```
