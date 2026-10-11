# Contributing to Seerr AI

Bug reports and ideas are welcome as [issues](../../issues/new/choose).
Problems with Seerr AI belong here, not with the Seerr project.

## Code

Work happens on the `dev` branch; `main` only moves for a release. Pull
requests go to `dev`.

[docs/FORK.md](docs/FORK.md) has what you need: building, the tests (run
them on SQLite and on PostgreSQL), writing migrations, and the rules this
fork learned the hard way. In short:

- Every change comes with tests, and both test runs pass.
- `pnpm lint`, `pnpm typecheck` and `pnpm build` pass.
- New text shown in the app goes through `defineMessages`, then
  `pnpm i18n:extract`.
- Every new API route is described in `seerr-api.yml`.
- A migration has a `postgres/` and a `sqlite/` version.
- Say what you used AI for, if anything, and make sure you understand
  everything you send.

Seerr AI is under the [MIT licence](LICENSE), as Seerr is; what you
contribute is too.
