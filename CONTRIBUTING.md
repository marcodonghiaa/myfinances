# Contributing

This is a solo-maintained project — PRs and issues are welcome, response time varies.

## Before opening a PR

1. Run the sync scripts locally against your own Supabase project (see the [Setup](README.md#setup) section) — there's no CI test suite yet, manual verification is the current bar.
2. For schema changes, add a new file under `supabase/migrations/`, never edit an existing one.
3. Keep PRs scoped to one change — easier to review, easier to revert if something breaks.

## Reporting bugs / security issues

- Regular bugs: open a GitHub issue with the bug report template.
- Anything touching real financial data, secrets, or auth: email the maintainer directly instead of opening a public issue.
