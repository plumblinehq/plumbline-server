# plumbline-server

Scheduler, Postgres store and HTTP API for [Plumbline](https://github.com/plumblinehq),
the Stellar anchor conformance directory. It runs the checks from
[`@plumblinehq/plumbline-checks`](https://github.com/plumblinehq/plumbline-checks)
on a schedule, stores every result, and computes grades and regressions. It
contains no check logic: if a check needs fixing it gets fixed upstream and
pulled in as a tag bump — never reimplemented or special-cased here.

## Relationship to SDF anchor-tests

The Stellar Development Foundation maintains
[`@stellar/anchor-tests`](https://github.com/stellar-anchor-tests) and hosts it
at anchor-validator.stellar.org; it is the right tool for an anchor operator
testing their own anchor, including authenticated flows. Plumbline is a
continuous, ecosystem-wide, read-only monitor and is never presented as a
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
| `SCAN_INTERVAL` | no | `21600` | Seconds between scan passes per anchor |
| `SCAN_JITTER` | no | `0.2` | ± fraction of the interval applied as jitter |
| `SCAN_CONCURRENCY` | no | `4` | Anchors scanned concurrently |
| `RUN_TIMEOUT` | no | `600` | Seconds before a run is marked `aborted` |

Missing required env is a hard startup failure: a server that comes up
half-configured and scans nothing is worse than one that refuses to boot.

## The dependency on the checks package

The checks package is distributed from GitHub, not npm: this repo pins a
release tag.

```json
"dependencies": {
  "@plumblinehq/plumbline-checks": "github:plumblinehq/plumbline-checks#v0.2.2"
}
```

npm runs that package's `prepare` script on install, so the install builds
itself. `npm ci` clones github to resolve it; in CI, rewrite `git+ssh` to the
runner token first (see `.github/workflows/ci.yml`).

## Commands

```
npm run db:migrate   # apply pending migrations (requires DATABASE_URL)
npm run scan         # one scan pass: seed lists, opt-outs, real rows
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

## Data model

Six tables, migrated forward-only from `migrations/`: `anchors`, `assets`,
`runs`, `check_results`, `sep_grades`, `regressions`. Every run records
`checks_lib_version` — the checks package's own `VERSION` export — because a
grade change across runs could mean the anchor broke or that Plumbline
changed; without that column every historical comparison would be
untrustworthy.

## License

Apache-2.0
