# Contributing

Thanks for considering a contribution to Plumbline.

Plumbline is three repositories in the `plumblinehq` org:

- **plumbline-checks** — the SEP conformance checks, as a library and CLI
- **plumbline-server** — scheduler, Postgres store, HTTP API
- **plumbline-web** — the public directory

This repo is `plumbline-server`: the scheduler, the Postgres store, the HTTP
API and regression alerts. It contains **no check logic**. If a check needs
fixing, it gets fixed in `plumbline-checks` and pulled in as a version bump of
that package — never reimplemented or special-cased here.

## Ground rules

- TypeScript in strict mode. No ORM, DI framework, component library or UI kit.
- The checks library is a pinned dependency. When the checks package releases a
  new version, bump the pin deliberately, in its own commit.
- Plumbline is read-only against third-party anchors: only `GET`, `HEAD` and
  `OPTIONS` requests. Nothing in this repo ever issues a `POST` to an anchor.
- One commit per logical unit, Conventional Commits style. A migration is one
  commit.
- Never commit a red build. CI must be green on the default branch.

## Development

Install, test and build commands are documented here as they land with each
stage of the build. The lockfile is committed.

- Tests must never touch the network — stub HTTP and the store layer.
- The seed anchor list lives in `seeds/anchors.yaml`, committed and
  hand-reviewed. The opt-out list lives in `optout.yaml`, likewise.

## Pull requests

Every PR runs lint, typecheck, tests and build on push. A red build blocks the
merge.

## Reporting bugs

Use the issue templates. If the bug is in a check's result, file it in
`plumbline-checks` with the `specRef`, not here.