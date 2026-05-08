# @firecrawl/scraper

Thin TypeScript CLI over the self-hosted Firecrawl API at `http://localhost:3002`.

Run via `tsx` — no build step needed. Tasks live in the repo-root `taskfile.yml`.

## Quick start

```bash
task scraper:install                                  # one-time
task scrape -- https://example.com                    # markdown → stdout
task scrape -- https://example.com -o page.md
task scrape:batch -- --file urls.txt --out ./out/
task crawl -- https://docs.example.com --limit 50 --out ./docs/
task map -- https://example.com --limit 100
```

## Commands

| Command           | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `scrape <url>`    | Single URL → one document                                 |
| `batch [urls...]` | Many URLs (args, `--file`, or `--stdin`) → many documents |
| `crawl <url>`     | Start a crawl, poll `/v1/crawl/:id`, stream results       |
| `map <url>`       | List URLs reachable on a site (no scraping)               |

### Global options

| Flag                  | Default               | Description                                    |
| --------------------- | --------------------- | ---------------------------------------------- |
| `-c, --config <path>` | `scraper.config.yaml` | YAML config file                               |
| `--api-url <url>`     | from config           | Override API base URL                          |
| `--profile <name>`    | `default`             | Named profile from config                      |
| `-f, --format <name>` | `markdown`            | `markdown` \| `html` \| `json` \| `screenshot` |

### Per-command options

- **scrape / batch / crawl / map** support `-o, --out <path>`:
  - `-` or omitted → stdout
  - path with extension → single file (results concatenated for batch)
  - path ending `/` or no extension → directory, one file per URL (`<host>/<path>.<ext>`)
- **batch**: `--file <path>`, `--stdin`, `--concurrency <n>`, `--resume`, `--no-progress`
- **crawl**: `--limit`, `--max-depth`, `--include-paths`, `--exclude-paths`, `--poll-ms`, `--no-progress`
- **map**: `--search`, `--limit`, `--ignore-sitemap`, `--include-subdomains`

## Output formats

| Format       | Ext     | Notes                                                        |
| ------------ | ------- | ------------------------------------------------------------ |
| `markdown`   | `.md`   | Default; cleanest for LLM workflows                          |
| `html`       | `.html` | Cleaned HTML (falls back to rawHtml)                         |
| `json`       | `.json` | Full Firecrawl response (markdown + html + links + metadata) |
| `screenshot` | `.png`  | Self-hosted API can't do this; **works with `--engine cdp`** |

## Config (`scraper.config.yaml`)

See `scraper.config.example.yaml`. Loaded from CWD (or `--config <path>`); zod-validated; `${ENV_VAR}` interpolation.

```yaml
apiUrl: http://localhost:3002
concurrency: 5
retries: { attempts: 3, initialDelayMs: 500 }

profiles:
  default: { formats: [markdown], onlyMainContent: true }
  docs: { excludeTags: [nav, footer, ".sidebar"] }
  with-shot: { formats: [markdown, screenshot], waitFor: 2000 }

domains:
  "example.com":
    headers:
      Cookie: "${EXAMPLE_COOKIE}"
  "*.docs.io":
    waitFor: 3000
```

**Merge order** (later wins): `default` profile → selected `--profile` → matched `domains.<host>` → CLI flags.

## Engines

Two backends, picked per request. The default `api` engine forwards to your self-hosted Firecrawl. The `cdp` engine drives **your real Chrome** via the DevTools Protocol — it's the same browser you read articles in, so there's literally no bot to detect.

Both engines use the same HTML→markdown converter (`turndown` — the same library Firecrawl itself ships in `apps/api`). The `cdp` engine adds a Firecrawl-style preprocessing pass: strips `script`/`style`/`nav`/`footer`/ads/modals/cookie banners, removes inline event handlers and `style` attrs, and (when `onlyMainContent: true`) runs Mozilla Readability for article extraction.

| Engine          | When to use                                                            | Limitations                                                                                                 |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `api` (default) | Public sites, sites without strong bot defense                         | Vanilla Playwright fingerprint; loses to Cloudflare/Akamai                                                  |
| `cdp`           | Paywalled sites you're logged into; sites that block headless Chromium | Single-URL `scrape`/`batch` only (no `crawl`/`map`); requires Chrome running with `--remote-debugging-port` |

**Resolution order** (winner takes all): `--engine` flag → `domains.<host>.engine` in YAML → `profiles.<name>.engine` → default `api`.

## Scraping subscription / paywalled sites

Only for sites you have a legitimate subscription to. Pick one of three approaches in increasing order of robustness:

### A. CDP — drive your real Chrome (most robust)

Launch a dedicated Chrome instance with a CDP port open, log into your subscription **once** in that window, then point the scraper at it. Bot detection passes because there is no bot — it's your real browser.

**One-time setup (Linux):**

```bash
mkdir -p "$HOME/.scraper-chrome"
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.scraper-chrome" &

# In that Chrome window, log in to NYT / FT / Substack / etc.
# Subscriptions persist in this profile across runs.
```

**One-time setup (macOS):**

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.scraper-chrome"
```

**Verify the port is open:**

```bash
curl -s http://localhost:9222/json/version | jq .Browser
```

**Scrape:**

```bash
# explicit per-call
task scrape -- https://www.nytimes.com/... --engine cdp

# or set a per-domain override in scraper.config.yaml:
#   domains:
#     "www.nytimes.com":
#       engine: cdp
# then just:
task scrape -- https://www.nytimes.com/...
```

`screenshot` format works on the CDP engine (it didn't on the API engine because self-hosted Firecrawl has no screenshot-capable engine).

**Important: use a separate `--user-data-dir`.** Don't point CDP at your daily-driver Chrome profile — anything connecting to the port has full access to every session you have.

### B. Cookie injection (fastest, less robust)

1. Log in via your browser → DevTools → Network → copy the `Cookie` header from any authenticated request.
2. Export the value to your shell (don't commit cookies to YAML):
   ```bash
   export NYT_COOKIE="..."
   ```
3. Add a per-domain override in `scraper.config.yaml`:
   ```yaml
   domains:
     "www.nytimes.com":
       headers:
         Cookie: "${NYT_COOKIE}"
         User-Agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
       waitFor: 2000
   ```
4. Scrape:
   ```bash
   task scrape -- https://www.nytimes.com/2026/01/15/some-article.html
   ```

The `Cookie` header is forwarded by the API to the underlying Playwright fetch, so the page renders as if you were logged in.

### C. Scripted login (when cookies rotate or are bound to IP)

Add an `actions` array to a profile — the API will navigate, type, click, then scrape:

```yaml
profiles:
  my-site-login:
    waitFor: 1500
    actions:
      - { type: write, selector: "#email", text: "${MY_EMAIL}" }
      - { type: write, selector: "#password", text: "${MY_PASSWORD}" }
      - { type: click, selector: "button[type=submit]" }
      - { type: wait, milliseconds: 2000 }
      - { type: scrape }
```

Then: `task scrape -- https://my-site.com/dashboard --profile my-site-login`.

### Caveats

- **Don't commit secrets.** Always use `${ENV_VAR}` in the YAML; the `scraper.config.yaml` is gitignored, but env vars are still safer.
- **Sessions expire.** Refresh `Cookie` when scrapes start returning login pages.
- **Anti-bot still bites.** A valid cookie doesn't beat Cloudflare/Akamai TLS fingerprinting. Self-hosted has no fire-engine, so heavily defended sites may 403 even logged in. Add a residential `PROXY_SERVER` in the API's `.env` if needed.
- **ToS.** Scraping a site you have access to is not the same as being allowed to scrape it. Read the Terms.

## Features

- **Retries** — 5xx, 408, 429, network errors. Exponential backoff. Honors `Retry-After`.
- **Resume** — `.scraper-state/<hash>.json` tracks completed/failed URLs. `--resume` skips done.
- **Per-domain overrides** — cookies, headers, wait times scoped to host (glob match).
- **Progress bar** — `cli-progress` on stderr; auto-off when output is stdout or stderr is non-TTY.
- **Concurrency** — `p-limit` on batches; default 5.

## Limitations

- **Self-hosted API has no fire-engine.** Screenshot, Cloudflare bypass, etc. are cloud-only on the `api` engine. Use `--engine cdp` (your real Chrome) when you hit a wall.
- **CDP engine: single-URL only.** `crawl` and `map` go through the API; only `scrape` and `batch` understand `--engine cdp`.
- **No auth on the local API.** Assumes the API has `USE_DB_AUTHENTICATION=false` (self-host default).
- **Sequential awaits in retry / crawl-poll loops** are intentional (each iteration depends on the previous result). The 8 `no-await-in-loop` lint hints are warnings, not errors.

## Extending

Each pluggable surface is a single file in its directory:

| Add a...      | Drop a file in... | Then register in...                             |
| ------------- | ----------------- | ----------------------------------------------- |
| Format        | `src/formats/`    | `src/formats/index.ts`                          |
| Input source  | `src/inputs/`     | wire into `src/cli.ts`                          |
| Output writer | `src/outputs/`    | wire into `src/outputs/index.ts` (`pickOutput`) |

Interfaces: `Format`, `InputSource`, `OutputWriter` (in each dir's `types.ts`).

## Toolchain

| Tool               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `tsx`              | Run TS directly                                         |
| `tsdown`           | Optional bundle (`task scraper:build` → `dist/cli.mjs`) |
| `tsgo`             | Typecheck (`task scraper:typecheck`)                    |
| `oxlint` / `oxfmt` | Lint + format (Rust-based)                              |
| `vitest`           | Tests                                                   |

All deps pinned exact (no `^`/`~`).

CI runs typecheck + lint + tests + build on every push or PR that touches `apps/scraper/**` (`.github/workflows/scraper-ci.yml`).
