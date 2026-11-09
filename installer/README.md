# create-alopex

One command to self-host Alopex:

```bash
npx create-alopex          # installs into ./alopex
npx create-alopex ~/money  # or a folder you choose
```

Needs Node 20+. No git, Docker, Homebrew or GitHub account: the Supabase and Vercel CLIs run through npx.

| Step | Automatic? |
| --- | --- |
| Download backend + dashboard | yes |
| Supabase sign-in | opens your browser |
| Project, tables, Edge Functions, secrets | yes |
| Your login, public sign-ups off | you type email + password |
| Enable Banking app (PSD2) | **manual**, about 10 min on their site: no API exists for it |
| Gemini key | optional, you paste it |
| Scheduled sync (pg_cron in Supabase, every 6 h) | yes |
| Dashboard on Vercel | opens your browser to sign in, then yes |

Run the same command in the same folder again to update: it re-downloads the code, keeps
`backend/.env`, applies new migrations and functions, and redeploys the dashboard.

Forks and testing: `ALOPEX_BACKEND_REPO`, `ALOPEX_DASHBOARD_REPO` (owner/name) and
`ALOPEX_REF` (branch, default `main`) choose what is downloaded.

Tests: `node --test installer/` (from the backend repo root).
