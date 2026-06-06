# no-bs-pdf

[![CI/CD - no-bs-pdf](https://github.com/igor-couto/no-bs-pdf.com/actions/workflows/cicd.yml/badge.svg)](https://github.com/igor-couto/no-bs-pdf.com/actions/workflows/cicd.yml)

![Preview](docs/preview.png)

A private, **fully client-side** PDF editor. Open a PDF, mark it up, reorganize pages,
and download the result. Your file is read, edited, and saved entirely in the browser —
**it is never uploaded to any server.** No cookies, no tracking, no accounts, no storage.

## What it does

- **Open** a PDF (file picker or drag &amp; drop)
- **Annotate**: add text, freehand pen, highlighter, rectangles, white-out (cover/redact), and stamp PNG/JPG images
- **Select / move / resize / delete** annotations; **undo / redo**
- **Pages**: reorder (drag thumbnails), rotate, duplicate, delete, insert blank pages, and **append another PDF**
- **Download** the edited PDF

## How privacy works

This app makes **zero third-party requests**. The two open-source libraries it uses —
[PDF.js](https://mozilla.github.io/pdf.js/) for rendering and
[pdf-lib](https://pdf-lib.js.org/) for writing — are **vendored locally** in `vendor/`,
so the only things ever loaded are files from this folder. Nothing is fetched from a CDN
at runtime.

**Your document is never part of any request.** It's read with the File API, edited in
page memory, and written back out with the browser's download mechanism (a `blob:` URL).
There is no backend, no upload, no `fetch`/`XHR` of your bytes, and nothing is written to
cookies, `localStorage`, or `IndexedDB`. It runs fully offline.

> The files in `vendor/` are the unmodified library builds (`pdf.min.js`,
> `pdf.worker.min.js` from PDF.js 3.11.174, and `pdf-lib.min.js` from pdf-lib 1.17.1).
> To update them, replace the files in `vendor/` with newer builds of the same names.

## Run it

It's just static files. Either open `index.html` directly, or (recommended, so the
PDF.js worker runs off the main thread and the SEO files are served with correct content
types) serve the folder with the bundled zero-dependency Node server:

```powershell
node .claude/serve.mjs . 8000
# then open http://localhost:8000
```

(Any static host works in production — Netlify, GitHub Pages, S3, nginx, etc.)

After changing `app.js` or `styles.css`, regenerate the served minified files:

```powershell
npx --yes terser@5 app.js --compress --mangle --format ascii_only=true,comments=false -o app.min.js
npx --yes clean-css-cli@5 styles.css -o styles.min.css
```

## Deployment (CI/CD)

`.github/workflows/cicd.yml` ships the site on every push to `main` (and via manual
**Run workflow**). It packages the static files into an nginx image, pushes to GHCR, then
rolls it out over SSH with a smoke test and automatic rollback.

**Pipeline**

1. **Validate** (GitHub-hosted) — checks JS syntax, validates `site.webmanifest` JSON,
   verifies `app.min.js` matches `app.js`, verifies `styles.min.css` matches
   `styles.css`, confirms the vendored libraries are present, and warns if the
   placeholder domain is still set.
2. **Build & push image** (self-hosted runner) — builds the `Dockerfile` for `linux/arm64`
   and pushes `ghcr.io/<owner>/no-bs-pdf:<sha>` and `:latest`.
3. **Deploy** (GitHub-hosted) — SSHes to the server, pulls the image, smoke-tests a
   throwaway container on `SMOKE_PORT`, then replaces the production container on
   `HOST_PORT`. If the new container fails its health check, it **rolls back** to the
   previously running image.

**The image** (`nginx:alpine`, see `Dockerfile` + `deploy/nginx.conf`) serves the files
with gzip, sensible cache headers, the correct `webmanifest` MIME type, and security
headers including a strict **Content-Security-Policy** — verified not to break PDF.js
(`script`/`worker` from `'self'` + `blob:`, `img` from `'self'`/`data:`/`blob:`, no
third-party origins).

**Required GitHub secrets**

| Secret | Purpose |
|--------|---------|
| `SSH_HOST` | server hostname / IP |
| `SSH_USER` | SSH user (container runs under `/home/<user>/apps/no-bs-pdf`) |
| `SSH_KEY` | private key for that user |
| `SSH_PORT` | SSH port (optional; defaults to `22`) |

`GITHUB_TOKEN` is provided automatically and is used to push to / pull from GHCR.

**Ports** (edit the workflow's `env:` if they clash with other apps on the server):
`HOST_PORT=50161` (published on `127.0.0.1`), `CONTAINER_PORT=80` (nginx),
`SMOKE_PORT=60161` (temporary, for the pre-switch smoke test). Point your reverse proxy
and TLS at `127.0.0.1:50161` — the site binds to loopback only, so the proxy is the sole
public entry point.

**Prerequisites**: a **self-hosted ARM64 runner** with Docker (same as the reference
setup), Docker on the target server, and the GHCR package readable by the server.

## SEO

The page is built to be indexed well even though it's a single client-side app:

- Descriptive, length-tuned `<title>` and `<meta name="description">`, plus `keywords`,
  `robots`, `theme-color` and a `canonical` link.
- **Open Graph** + **Twitter Card** tags with a 1200×630 social image (`og-image.svg`).
- **Structured data** (JSON-LD): a `WebApplication` entry and a `FAQPage` that mirrors the
  on-page FAQ — both eligible for rich results.
- Real, crawlable content: a single `<h1>`, a clean `<h2>` outline, feature/how-to
  sections and an FAQ describing what the tool does.
- `robots.txt`, `sitemap.xml`, and a PWA `site.webmanifest` (installable, theme-colored).
- Fast first paint: the app shell loads first, and the vendored PDF libraries are
  lazy-loaded only when a document is opened.

### ⚠️ Before you deploy: set your domain

Absolute URLs use the reserved placeholder `https://no-bs-pdf.com`. Replace it with
your real URL in these files:

- `index.html` — `canonical`, `og:url`, `og:image`, `twitter:image`, and the `url` in the
  WebApplication JSON-LD
- `robots.txt` — the `Sitemap:` line
- `sitemap.xml` — the `<loc>`

> Tip: `og-image.svg` works on platforms that render SVG previews. For the widest social
> compatibility, also export it to a 1200×630 **PNG** and point `og:image`/`twitter:image`
> at that file.

## Files

| File | Purpose |
|------|---------|
| `index.html` | markup, SEO metadata, structured data, landing content |
| `styles.css` | readable source styling (editor + landing page) |
| `styles.min.css` | minified stylesheet served in production |
| `app.js` | readable source for all editor logic (rendering, tools, page ops, export) |
| `app.min.js` | minified app bundle served in production |
| `vendor/` | bundled PDF.js + pdf-lib (so there are zero third-party requests) |
| `icon.svg` | favicon / app icon |
| `og-image.svg` | social share card (1200×630) |
| `site.webmanifest` | PWA manifest |
| `robots.txt`, `sitemap.xml` | crawler directives |
| `.claude/serve.mjs` | tiny local static server for development |

## Notes &amp; limits

- Text is rendered with the standard **Helvetica** font on export.
- Encrypted/password-protected PDFs must be unlocked first.
- Combining heavy text placement with per-page rotation can have minor orientation quirks;
  position is always preserved. Rotation 0 (the common case) is exact.
