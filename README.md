# image_api

A small Cloudinary-style image processing service: give it an image URL and it
resizes, crops and re-encodes it on the fly. Includes an explorer UI at `/`.

> **Status:** API complete; UI and deployment in progress (see [docs/PLAN.md](docs/PLAN.md)).

## Quick start

```bash
nvm use            # Node 24 (see .nvmrc)
npm install
npm run dev        # http://localhost:3000
npm test
```

Docker:

```bash
docker build -t image-api .
docker run --rm -p 3000:3000 image-api
```

Configuration is environment-only; see [.env.example](.env.example) for every knob and its default.

## API

### `GET /process`

| Param     | Type                              | Notes                                                    |
|-----------|-----------------------------------|----------------------------------------------------------|
| `url`     | http(s) URL, **required**         | Public image to transform                                |
| `width`   | int 1–4000                        | Omit one of width/height to keep aspect ratio            |
| `height`  | int 1–4000                        |                                                          |
| `format`  | `jpeg` (`jpg`), `png`, `webp`, `avif` | Defaults to the source format (gif/tiff → png)       |
| `quality` | int 1–100                         | Lossy formats only                                       |
| `crop`    | `fit` (default), `fill`, `scale`, `pad` | Needs width and/or height                          |

```bash
curl -o out.webp "http://localhost:3000/process?url=https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png&width=400&format=webp"
```

Crop modes: **fit** scales to fit inside the box · **fill** covers the box and crops the overflow ·
**scale** stretches to the exact box · **pad** fits inside and pads the remainder.

Response headers worth knowing: `X-Source-{Format,Width,Height,Bytes}`, `X-Output-{Width,Height}`,
`X-Cache: HIT|MISS`, `ETag`, `Cache-Control`, `X-Request-Id`, `X-RateLimit-*`.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "INVALID_PARAMS", "message": "width must be at most 4000", "details": [{ "param": "width", "message": "..." }] },
  "requestId": "..." }
```

| Status | Code                     | When                                                         |
|--------|--------------------------|--------------------------------------------------------------|
| 400    | `INVALID_PARAMS`         | Missing/invalid/unknown parameters                           |
| 400    | `URL_NOT_ALLOWED`        | Non-http(s) scheme, private/internal address, odd port, creds in URL |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | Source isn't a supported image                               |
| 422    | `SOURCE_TOO_LARGE`       | Over the byte or pixel limit                                 |
| 429    | `RATE_LIMITED`           | Too many requests                                            |
| 502    | `SOURCE_ERROR` / `SOURCE_UNREACHABLE` | Upstream returned non-2xx / couldn't connect    |
| 504    | `SOURCE_TIMEOUT`         | Upstream too slow                                            |

### `GET /health`

Liveness plus cache hit/miss counters.

## Architecture

TODO — Fastify + sharp; `params` (zod) → `ResultCache` (LRU + single-flight) → `safeFetch` (SSRF guard) → `transform` (sharp).

## Limits & safeguards

TODO — table of each limit, the value, and why.

## Trade-offs

TODO

## Deployment

AWS, defined in [infra/](infra/) with CDK (TypeScript):

```
Browser ─▶ CloudFront (HTTPS, shared cache keyed on query string)
             └─ OAC-signed ─▶ Lambda Function URL (IAM auth: CloudFront only)
                               └─ Lambda: this repo's Dockerfile + AWS Lambda Web Adapter
```

- The same container image runs locally (`docker run`) and on Lambda; the Web Adapter
  extension is inert outside Lambda.
- CloudFront caches successful `/process` responses per `Cache-Control` (1 day); errors and
  `/health` send `no-store`.
- Concurrency is the hard cost/abuse ceiling: new AWS accounts cap Lambda at 10 concurrent
  executions account-wide (and refuse per-function reservations); on larger accounts pass
  `-c reservedConcurrency=10` to `cdk deploy`. The in-app rate limiter keys on
  `CloudFront-Viewer-Address`, which is trustworthy because the function URL only accepts
  CloudFront-signed requests.
- Cold starts of ~1–2s are expected after idle periods.

Prerequisites: Docker, AWS credentials in the CLI (`aws configure` or `aws login`).

```bash
cd infra
npm install
npx cdk bootstrap   # once per account/region
npx cdk deploy      # builds the image, pushes to ECR, prints the CloudFront URL
npx cdk destroy     # tear down
```

## What I'd do next

TODO
