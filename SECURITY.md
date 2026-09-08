# Security

Plumbline is read-only by design: it issues only `GET`, `HEAD` and `OPTIONS`
requests to third-party anchors and never submits signed transactions. The
server stores no secrets and no credentials for third-party anchors.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. Do not open a public issue for a
security vulnerability.

Reports are acknowledged within 48 hours. Sensitive fix details are coordinated
privately before any public disclosure.

## Scope

- The scheduler, the HTTP API, the badge endpoint and the Postgres store
- Anything that parses untrusted input, notably evidence bodies persisted from
  third-party anchors

## Notes for contributors

- Evidence stored by the server is truncated to 2 KB and redacted upstream in
  `plumbline-checks`; the server must never widen that.
- No secrets in evidence, no secrets in logs, no secrets in environment
  defaults. Config fails fast on missing required env vars.
- The API is public and CORS-open by design; rate limiting protects it.