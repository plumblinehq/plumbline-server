# plumbline-server

Postgres store and HTTP API for [Plumbline](https://github.com/plumblinehq),
the Stellar anchor conformance directory. **A live instance runs at
<https://plumbline-server.onrender.com>** — the public API the directory's web
front end consumes. A scheduled GitHub Actions workflow runs the checks from
[`@plumblinehq/plumbline-checks`](https://github.com/plumblinehq/plumbline-checks)
against every anchor every 15 minutes; this service stores every result and
computes grades and regressions. It contains no check logic: if a check needs
fixing it gets fixed upstream and pulled in as a tag bump — never reimplemented
or special-cased here.

## Relationship to SDF anchor-tests

The Stellar Development Foundation maintains
[`@stellar/anchor-tests`](https://github.com/stellar-anchor-tests) and hosts it
at anchor-validator.stellar.org; it is the right tool for an anchor operator
testing their own anchor, including authenticated flows. Plumbline is a
scheduled, ecosystem-wide, read-only monitor and is never presented as a
replacement for it.

## Hard boundaries

These are guard conditions, not preferences:

1. **Read-only.** Plumbline issues only `GET`, `HEAD` and `OPTIONS` requests to
   third-party anchors. It never `POST`s.
2. **SEP-10 challenges are fetched and verified, never signed and never
   submitted.**
3. **No deposit or withdrawal flows against third-party anchors. Ever.**
4. **No funded accounts.**
5. **Politeness by default.** One request in flight per host, minimum 2s
   between requests to the same host, jittered scheduling, a `User-Agent`
   carrying a contact URL, and the committed `seeds/optout.yaml` as the
   documented opt-out. Any anchor that asks to be removed is removed.
6. **No secrets in evidence.** Response bodies stored as evidence are truncated
   to 2 KB and redacted by the checks package before persistence.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `SCAN_CONCURRENCY` | no | `4` | Anchors scanned concurrently |
| `RUN_TIMEOUT` | no | `600` | Seconds before a run is marked `aborted` |
| `PORT` | no | `3000` | Port the HTTP API listens on |
| `HOST` | no | `0.0.0.0` | Interface to bind |
| `RATE_LIMIT_MAX` | no | `300` | Requests per IP per window on the API; `0` disables the limit (local dev) |
| `RATE_LIMIT_WINDOW` | no | `60` | Rate-limit window in seconds |
| `REGRESSION_WEBHOOK_URL` | no | — | Generic webhook (Discord/Slack/HTTP) receiving regression alerts; unset means no alerts |
| `ALERT_COOLDOWN` | no | `86400` | Seconds to suppress repeat alerts for the same regression |
| `TRUST_PROXY` | no | `false` | Trust `X-Forwarded-For` when behind a reverse proxy (required for correct per-IP rate limiting) |

Missing required env is a hard startup failure: a server that comes up
half-configured and scans nothing is worse than one that refuses to boot.

## The dependency on the checks package

The checks package is distributed from GitHub, not npm: this repo pins a
release tag.

```json
"dependencies": {
  "@plumblinehq/plumbline-checks": "github:plumblinehq/plumbline-checks#v0.2.3"
}
```

npm runs that package's `prepare` script on install, so the install builds
itself. `npm ci` clones github to resolve it; in CI, rewrite `git+ssh` to the
runner token first (see `.github/workflows/ci.yml`).

## Commands

```
npm start            # the API server: migrations + HTTP API, no scanning
npm run db:migrate   # apply pending migrations (requires DATABASE_URL)
npm run scan         # one scan pass; what the scheduled workflow runs
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

## HTTP API

GET-only by construction — there is no POST route to reach. CORS is open for
GET, OPTIONS preflights are answered, and a fixed-window per-IP rate limit
protects the API (health and metrics endpoints are exempt so monitoring
probes can never trip it). Responses are envelope-free JSON.

```
GET /healthz
GET /readyz                                    # 503 until Postgres answers
GET /metrics                                   # Prometheus text format
GET /api/anchors?network=pubnet&sep=10&min_score=0.8&sort=score
GET /api/anchors/{home_domain}
GET /api/anchors/{home_domain}/runs?limit=20
GET /api/anchors/{home_domain}/history?days=30
GET /api/runs/{run_id}
GET /api/checks                                # the check catalogue, with spec references
GET /badge/{home_domain}.svg                   # shields-compatible, cached 1h
```

`min_score` compares against the overall score, or against the selected SEP's
score when `sep` is also given. An anchor that does not implement a SEP is
never listed for it: `sep=24` returns only anchors with an applicable SEP-24
grade.

Regression alerts are POSTed to `REGRESSION_WEBHOOK_URL` as JSON with the
anchor, run id, checks version, overall score and each regressed check's
message and spec reference. The same regression is not re-alerted within
`ALERT_COOLDOWN`; every occurrence is still recorded in the `regressions`
table.

## Data model

Six tables, migrated forward-only from `migrations/`: `anchors`, `assets`,
`runs`, `check_results`, `sep_grades`, `regressions`. Every run records
`checks_lib_version` — the checks package's own `VERSION` export — because a
grade change across runs could mean the anchor broke or that Plumbline
changed; without that column every historical comparison would be
untrustworthy.

## Scanning schedule

This service does not scan. `.github/workflows/scan.yml` runs `npm run scan`
on a GitHub Actions schedule — **nominally every 15 minutes**. Two caveats,
stated rather than glossed over:

- GitHub queues scheduled workflows and may delay them under load, so the real
  interval can be longer than 15 minutes.
- GitHub disables scheduled workflows after 60 days without repository
  activity.

The workflow needs a `DATABASE_URL` repository secret. `npm run scan` holds a
Postgres advisory lock for the duration of a pass, so a slow pass and the next
scheduled run can never overlap: one request in flight per host is guaranteed
within a scan, and the lock stops scans from stacking on top of each other.

Decoupling the scan from the web service is deliberate. A scheduler inside the
API server only ran while the host was awake, so on a free plan the recorded
history thinned out to whenever someone happened to hit the API while the
README still claimed a fixed interval. With the scan on its own schedule the
API can sleep freely, and the recorded interval is the workflow's.

## Deployment

The reference deployment is a Render free-tier web service built from the
committed `render.yaml` blueprint (region Ohio, matching the Neon Postgres it
reads) with `DATABASE_URL` set in the dashboard. The service serves the API and
applies migrations at boot; it does not scan. Render's free plan spins a web
service down after 15 minutes of inactivity, which now costs the API a cold
start and nothing else — scanning continues on its own schedule regardless of
whether the API is awake.

## License

Apache-2.0
