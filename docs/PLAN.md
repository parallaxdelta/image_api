# Plan & status

Brief: Ours Privacy SWE take-home — Cloudinary-style image service + explorer UI.
Received 2026-10-20 · **submit to akim@oursprivacy.com by 2026-10-27** · deployment (if any) must stay up ≥7 days after submitting.
Budget: "a couple of hours" — trade-offs documented > extra features.

## Part 1 — API ✅ scaffolded and working
- [x] `GET /process?url&width&height&format&quality&crop`
- [x] Strict param validation (unknown params → 400 so typos like `widht` are caught)
- [x] Uniform error envelope `{ error: { code, message, details? }, requestId }`
- [x] SSRF guard: http/https only, ports 80/443, no creds-in-URL, IP-literal check,
      connect-time DNS check (defeats rebinding), redirects re-validated per hop (max 3)
- [x] Limits: 8s total fetch budget, 15MB source, 40MP decode cap, 4000px output, sharp 10s timeout
- [x] Input-type allowlist via content sniffing (not Content-Type); SVG excluded
- [x] Rate limit 60/min/IP on `/process` only
- [x] Cache: byte-bounded LRU + single-flight, `Cache-Control`, `ETag`/304, `X-Cache`
- [x] `/health`, request IDs (honours inbound `x-request-id`), CORS w/ exposed metadata headers

## Part 2 — UI ✅ built (public/index.html, app.js, styles.css)
Vanilla HTML/JS in `public/`, served by the same app, calling `/process` like any consumer.
- [x] Form: URL, width, height, format, quality (slider), crop mode; sample-image buttons for the empty state
- [x] Side-by-side original vs processed with dims / format / size
      (processed via response; original via `X-Source-*` headers — no private endpoint needed)
- [x] Live request URL + copy button + curl snippet
- [x] Error panel rendering `error.code` / `message` / `details` / `requestId`
- [x] Loading state; disable submit while in flight; object URL cleanup
- [x] Explorer state round-trips through the page query string (shareable links)
- [ ] Polish pass at real browser size (only checked in a small pane so far)

## Part 3 — Deploy ✅ live at https://dv83ypneeeh28.cloudfront.net (deployed 2026-10-23, us-east-1)
Chose option 1 below; Lambda Web Adapter instead of `@fastify/aws-lambda`, so no adapter code.
Verified live: health, UI, transform, CloudFront HIT on repeat, ETag 304, SSRF blocks (metadata IP + rebinding host),
errors `no-store`, direct function URL → 403. **Keep it up ≥7 days after submitting.**

Constraint: free tier, up ≥7 days, reproducible from repo, secrets via env.
Options to decide between when creds arrive:
1. **Lambda (container image from this Dockerfile) + Function URL, CloudFront in front** — effectively free,
   CloudFront provides the shared cache layer; needs a small `src/lambda.ts` adapter (`@fastify/aws-lambda`).
   Cold starts ~1s (sharp). In-memory cache/rate limit become per-instance → note in README.
2. **EC2 t-class free-tier instance running the Docker image** — simplest mental model, no adapter,
   but depends on the account's free-tier eligibility and needs TLS (Caddy) + a box to babysit.
3. App Runner / ECS Fargate — cleanest container hosting but not free.
IaC: whichever we pick, keep it in `infra/` (SAM/CDK/Terraform) with a documented one-command deploy.
Set `TRUST_PROXY=true` behind CloudFront/ALB so rate limiting keys on the real client IP.

## Bonus (pick ≤2)
- [ ] CI did not set up.
- [ ] OpenAPI spec + interactive docs (`@fastify/swagger`) — cheap given zod schemas
- [x] Observability: one structured log line per request + EMF metrics, CloudFront access logs (no IPs) to CloudWatch, saved Logs Insights queries, dashboard, throttle alarm (all in CDK)

## README must cover
setup/run/test · live URL + deploy steps · architecture + trade-offs · limits & safeguards (with *why*) · next steps
