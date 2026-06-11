# Canva PDF API

NestJS API that converts a public Canva design link into a downloadable PDF.

## Setup

```bash
npm install
npm run install:browsers
cp .env.example .env
npm run start:dev
```

By default the API runs on `http://localhost:5001` when `PORT=5001` is set in `.env`.

## API

### POST export

```bash
curl -X POST http://localhost:5001/canva/export \
  -H "Content-Type: application/json" \
  -d '{"url":"https://canva.link/rf6rzlnni2fpmuk"}' \
  -o canva.pdf
```

### GET export

```bash
curl "http://localhost:5001/canva/export?url=https%3A%2F%2Fcanva.link%2Frf6rzlnni2fpmuk" \
  -o canva.pdf
```

Both endpoints return the PDF directly with `Content-Type: application/pdf`.

The generated filename is taken from the Canva page `<title>` when available. For example:

```html
<title>Software engineer - Phan Nhat Loi Resume</title>
```

returns:

```text
Software engineer - Phan Nhat Loi Resume.pdf
```

## Environment

```bash
PORT=5001
DOWNLOAD_DIR=storage/downloads
CANVA_EXPORT_TIMEOUT_MS=120000
CANVA_EXPORT_RATE_LIMIT=10
CANVA_EXPORT_RATE_LIMIT_WINDOW_MS=60000
CANVA_EXPORT_GET_CACHE_ENABLED=true
CANVA_EXPORT_GET_CACHE_TTL_MS=600000
CANVA_EXPORT_BLOB_CACHE_ACCESS=private
BLOB_STORE_ID=
BLOB_READ_WRITE_TOKEN=
PUPPETEER_HEADLESS=true
```

## GET Cache

The GET endpoint can cache generated PDFs in Vercel Blob.

```bash
BLOB_STORE_ID=store_xxx
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx
CANVA_EXPORT_GET_CACHE_ENABLED=true
CANVA_EXPORT_GET_CACHE_TTL_MS=600000
CANVA_EXPORT_BLOB_CACHE_ACCESS=private
```

Cache behavior:

- `X-Cache: HIT`: PDF was loaded from Vercel Blob.
- `X-Cache: MISS`: PDF was generated and queued for background Blob upload.
- `X-Cache: BYPASS`: cache is disabled or Blob credentials are missing.

Set this to disable GET caching while testing other behavior:

```bash
CANVA_EXPORT_GET_CACHE_ENABLED=false
```

Cached files are stored under:

```text
canva-export-cache/
```

The TTL controls whether a cached file is reused. Expired files are ignored, but they are not automatically deleted from Blob storage.

## Rate Limiting And Queueing

The API processes one export at a time per server instance to reduce Chromium resource contention.

```bash
CANVA_EXPORT_RATE_LIMIT=10
CANVA_EXPORT_RATE_LIMIT_WINDOW_MS=60000
```

With the default values, each server instance accepts up to 10 export requests per 60 seconds.

## Vercel Deployment

On Vercel, you do not need to run:

```bash
npm run install:browsers
```

Serverless runtime uses Chromium from `@sparticuz/chromium`. Local development uses the browser installed by Puppeteer.

If you want to provide your own Chromium executable, set:

```bash
PUPPETEER_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium
```

## Implementation Notes

Canva does not provide an official public API for exporting any public design link directly to PDF. This project uses Puppeteer to open the public Canva link, detect the number of pages, render each page through URL fragments such as `#1`, `#2`, and generate a PDF from the rendered design area.

Because Canva can change its viewer DOM at any time, PDF sizing and cropping logic in `src/canva/canva-export.service.ts` may need adjustments if output starts rendering with the wrong size or crop.
