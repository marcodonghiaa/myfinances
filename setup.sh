#!/bin/bash
# Guided self-host setup: creates (or links) a Supabase project, applies the
# schema, deploys the bank-linking Edge Functions, and writes both apps'
# .env files. Safe to run again: it reuses the values already in .env, only
# asks for what's missing, and applies any new migrations and functions.
#
# Forgot your password? ./setup.sh --reset-password
#
# It also creates your login (the app has no sign-up screen) and switches off
# public sign-ups so nobody else can create an account on your instance.
#
# What it CANNOT automate: signing up for Enable Banking and creating your
# PSD2 application there is a manual step on their site -- there's no API
# for it. This script asks for the app ID + private key once you have them.
set -euo pipefail
cd "$(dirname "$0")"

FRONTEND_DIR="${FRONTEND_DIR:-../my-wealth-view}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { echo; bold "==> $1"; }
die() { echo "Error: $1" >&2; exit 1; }
# Value already in this install's .env ('' when missing), so a re-run doesn't ask again.
existing() { node env-file.js get .env "$1"; }

if [ "${1:-}" = "--reset-password" ]; then
  SUPABASE_URL=$(existing SUPABASE_URL)
  SECRET_KEY=$(existing SUPABASE_SECRET_KEY)
  [ -n "$SUPABASE_URL" ] && [ -n "$SECRET_KEY" ] || die "No SUPABASE_URL / SUPABASE_SECRET_KEY in .env. Run ./setup.sh first."
  read -rp "Email of your login: " LOGIN_EMAIL
  read -rsp "New password (6+ characters, not shown): " LOGIN_PASSWORD
  echo
  SETUP_URL="$SUPABASE_URL" SETUP_SECRET_KEY="$SECRET_KEY" SETUP_EMAIL="$LOGIN_EMAIL" SETUP_PASSWORD="$LOGIN_PASSWORD" node first-user.js --reset >/dev/null \
    || die "Could not reset the password (see message above)."
  echo "Password changed for $LOGIN_EMAIL."
  exit 0
fi

step "Where should the sync run?"
echo "  1) GitHub Actions: free, no computer has to stay on. Needs your fork of this repo and the GitHub CLI (gh)."
echo "  2) Docker on this computer: the sync runs only while it is on."
PREVIOUS_SYNC_ON=$(existing SYNC_ON)
if [ "$PREVIOUS_SYNC_ON" = "docker" ]; then DEFAULT_CHOICE=2; else DEFAULT_CHOICE=1; fi
read -rp "Choose 1 or 2 [$DEFAULT_CHOICE]: " SYNC_CHOICE
case "${SYNC_CHOICE:-$DEFAULT_CHOICE}" in
  1) SYNC_ON=github ;;
  2) SYNC_ON=docker ;;
  *) die "Choose 1 or 2." ;;
esac

step "Checking prerequisites"
command -v supabase >/dev/null || die "supabase CLI not found. Install: brew install supabase/tap/supabase"
command -v node >/dev/null || die "node not found. Install Node 22: https://nodejs.org"
command -v npx >/dev/null || die "npx not found (ships with Node)."
if [ "$SYNC_ON" = "docker" ]; then
  command -v docker >/dev/null || die "docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
  docker compose version >/dev/null 2>&1 || die "docker compose (v2 plugin) not found. Update Docker Desktop, or install the compose plugin."
  [ -d "$FRONTEND_DIR" ] || die "Frontend repo not found at $FRONTEND_DIR. Clone it as a sibling directory, or set FRONTEND_DIR=/path/to/my-wealth-view."
  echo "OK: supabase CLI, node, docker, frontend repo at $FRONTEND_DIR"
else
  command -v gh >/dev/null || die "GitHub CLI not found. Install: https://cli.github.com (or choose 2 for Docker)."
  gh auth status >/dev/null 2>&1 || gh auth login
  # Secrets go to the repo this folder was cloned from, which must be yours: a fork.
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || die "This folder is not a GitHub repository. Fork myfinances on GitHub, clone your fork and run setup there."
  [ "$(gh repo view "$REPO" --json viewerPermission --jq .viewerPermission)" = "ADMIN" ] \
    || die "You can't set secrets on $REPO. Fork myfinances on GitHub, clone your fork and run setup there."
  echo "OK: supabase CLI, node, GitHub CLI, your repo $REPO"
fi

json_get() {
  # json_get '<json>' 'key' -- tiny JSON field reader, avoids adding a jq dependency
  node -e "const d=JSON.parse(process.argv[1]); const v=process.argv[2].split('.').reduce((o,k)=>o?.[k], d); if (Array.isArray(v)) console.log(JSON.stringify(v)); else console.log(v ?? '')" "$1" "$2"
}

step "Supabase login"
if ! supabase projects list >/dev/null 2>&1; then
  echo "Not logged in -- opening browser."
  supabase login
fi

step "Supabase project"
PREVIOUS_URL=$(existing SUPABASE_URL)
PROJECT_REF=""
if [ -n "$PREVIOUS_URL" ]; then
  PREVIOUS_REF=$(echo "$PREVIOUS_URL" | sed -E 's#https://([a-z0-9]+)\.supabase\.co/?#\1#')
  read -rp "Keep using project $PREVIOUS_REF from .env? [Y/n] " KEEP_PROJECT
  [[ "$KEEP_PROJECT" =~ ^[Nn]$ ]] || PROJECT_REF="$PREVIOUS_REF"
fi
if [ -n "$PROJECT_REF" ]; then
  echo "Using project $PROJECT_REF."
else
read -rp "Use an existing Supabase project? [y/N] " USE_EXISTING
if [[ "$USE_EXISTING" =~ ^[Yy]$ ]]; then
  read -rp "Project ref (20-char id from the dashboard URL): " PROJECT_REF
  PROJECTS_JSON=$(supabase projects list --output json)
  node -e "
    const projects = JSON.parse(process.argv[1]);
    process.exit(projects.some(p => p.id === process.argv[2]) ? 0 : 1);
  " "$PROJECTS_JSON" "$PROJECT_REF" || die "No project with ref '$PROJECT_REF' found in your Supabase account. Check the ref (from the dashboard URL, e.g. supabase.com/dashboard/project/<ref>) and try again."
else
  ORGS_JSON=$(supabase orgs list --output json)
  ORG_ID=$(json_get "$ORGS_JSON" "0.id")
  ORG_NAME=$(json_get "$ORGS_JSON" "0.name")
  [ -n "$ORG_ID" ] || die "No Supabase organization found. Create one at supabase.com/dashboard first."
  echo "Using organization: $ORG_NAME ($ORG_ID)"
  read -rp "New project name [finance-app]: " PROJECT_NAME
  PROJECT_NAME="${PROJECT_NAME:-finance-app}"
  DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
  read -rp "Region [eu-central-1]: " REGION
  REGION="${REGION:-eu-central-1}"
  echo "Creating project (this takes a minute)..."
  CREATE_JSON=$(supabase projects create "$PROJECT_NAME" --org-id "$ORG_ID" --db-password "$DB_PASSWORD" --region "$REGION" --output json)
  PROJECT_REF=$(node -e "const p=JSON.parse(process.argv[1]); console.log(p.id ?? p.ref ?? '')" "$CREATE_JSON")
  [ -n "$PROJECT_REF" ] || die "Project creation did not return a ref. Response was: $CREATE_JSON"
  # Nothing here needs the database password again, so it is not printed (it would stay in
  # the terminal history). Reset it in the dashboard (Project Settings -> Database) if needed.
  echo "Created project $PROJECT_REF."
fi
fi

step "Linking and applying schema"
echo "New projects take a minute or two to finish provisioning -- retrying until ready."
for i in $(seq 1 20); do
  if supabase link --project-ref "$PROJECT_REF" 2>/tmp/setup-link-err; then
    break
  fi
  [ "$i" -eq 20 ] && { cat /tmp/setup-link-err >&2; die "Project never became ready after ~10 minutes."; }
  sleep 30
done
supabase db push --yes
echo "Migrations applied."

step "Fetching API keys"
KEYS_JSON=$(supabase projects api-keys --project-ref "$PROJECT_REF" --reveal --output json)
# Match by key prefix, not array position/order -- sb_publishable_.../sb_secret_...
# are Supabase's stable naming, safer than trusting field names or ordering.
PUBLISHABLE_KEY=$(node -e "
const keys = JSON.parse(process.argv[1]);
console.log(keys.find(k => k.api_key?.startsWith('sb_publishable_'))?.api_key ?? '');
" "$KEYS_JSON")
SECRET_KEY=$(node -e "
const keys = JSON.parse(process.argv[1]);
console.log(keys.find(k => k.api_key?.startsWith('sb_secret_'))?.api_key ?? '');
" "$KEYS_JSON")
[ -n "$PUBLISHABLE_KEY" ] && [ -n "$SECRET_KEY" ] || die "Could not find sb_publishable_/sb_secret_ keys. Verify the Supabase CLI response format."
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
echo "Got URL and keys."

step "Your login"
USER_ID=$(existing USER_ID)
if [ -n "$USER_ID" ] && [ "$PROJECT_REF" = "${PREVIOUS_REF:-}" ]; then
  echo "Login already set up (USER_ID in .env). To change its password: ./setup.sh --reset-password"
else
echo "The app has no sign-up screen, so the login is created here. Re-running with the same email keeps the existing user."
read -rp "Email: " LOGIN_EMAIL
read -rsp "Password (6+ characters, not shown): " LOGIN_PASSWORD
echo
# Credentials go in as environment variables so they never appear in the process list.
USER_ID=$(SETUP_URL="$SUPABASE_URL" SETUP_SECRET_KEY="$SECRET_KEY" SETUP_EMAIL="$LOGIN_EMAIL" SETUP_PASSWORD="$LOGIN_PASSWORD" node first-user.js) || die "Could not create your login (see message above)."
unset LOGIN_PASSWORD
echo "Login ready for $LOGIN_EMAIL."
fi

step "Enable Banking (manual signup required)"
EB_APP_ID=$(existing APP_ID)
EB_PRIVATE_KEY_ENV=$(existing PRIVATE_KEY)
EB_PEM_PATH=$(existing PRIVATE_KEY_FILE)
if [ -n "$EB_APP_ID" ] && [ -n "$EB_PRIVATE_KEY_ENV" ]; then
  echo "Using the Enable Banking app from .env ($EB_APP_ID)."
  EB_PRIVATE_KEY=$(node -e 'process.stdout.write(process.argv[1].replace(/\\n/g, "\n"))' -- "$EB_PRIVATE_KEY_ENV")
else
echo "If you haven't already: sign up at https://enablebanking.com/sign-in/,"
echo "then in the Control Panel -> API applications -> Add a new application:"
echo "  - Choose Production (not Sandbox)"
echo "  - Redirect URL: https://${PROJECT_REF}.supabase.co/functions/v1/bank-consent-callback"
echo "  - Register -> downloads a .pem private key to your Downloads folder"
echo "The app starts Inactive. Click 'Activate by linking accounts' and link any"
echo "one of your own accounts through Enable Banking's UI -- this unlocks the"
echo "app for free Restricted Production use. It does NOT connect that account"
echo "to this app yet; you'll do that separately from this app's own dashboard"
echo "once setup finishes."
read -rp "Enable Banking APP_ID: " EB_APP_ID
read -rp "Path to the downloaded .pem private key: " EB_PEM_PATH
[ -f "$EB_PEM_PATH" ] || die "No file at $EB_PEM_PATH"
EB_PRIVATE_KEY=$(cat "$EB_PEM_PATH")
# .env is one KEY=VALUE per line -- the real multi-line PEM above is fine as
# a `supabase secrets set` argument, but breaks .env parsing the moment a
# body line starts with a character like '+'. For the .env file only, store
# it as a single line with literal \n escapes instead (same convention as
# Firebase/GCP service-account keys in .env files); sync-transactions.js and
# sync-networth.js unescape it back to real newlines when they read it.
EB_PRIVATE_KEY_ENV=$(awk '{printf "%s\\n", $0}' "$EB_PEM_PATH")
fi

step "VAPID keys for push notifications"
VAPID_PUBLIC=$(existing VAPID_PUBLIC_KEY)
VAPID_PRIVATE=$(existing VAPID_PRIVATE_KEY)
# Keep existing keys: new ones would silently break every phone already subscribed.
if [ -n "$VAPID_PUBLIC" ] && [ -n "$VAPID_PRIVATE" ]; then
  echo "Using the keys from .env."
else
VAPID_OUT=$(npx --yes web-push generate-vapid-keys 2>&1)
VAPID_PUBLIC=$(echo "$VAPID_OUT" | grep -A1 "Public Key" | tail -1 | tr -d '[:space:]')
VAPID_PRIVATE=$(echo "$VAPID_OUT" | grep -A1 "Private Key" | tail -1 | tr -d '[:space:]')
[ -n "$VAPID_PUBLIC" ] && [ -n "$VAPID_PRIVATE" ] || die "Could not parse VAPID keys from web-push output."
echo "Generated."
fi

step "Gemini API key (recommended: AI sorts your transactions into categories)"
echo "Get one free at https://aistudio.google.com/apikey"
echo "Leave empty to skip: only the rules you write in the app will categorize, and"
echo "subscriptions won't be detected. You can add a key to .env later."
GEMINI_API_KEY=$(existing GEMINI_API_KEY)
if [ -n "$GEMINI_API_KEY" ]; then
  echo "Using the key from .env."
else
  read -rp "GEMINI_API_KEY (Enter to skip): " GEMINI_API_KEY
fi

step "Frontend URL (for bank-linking redirects)"
PREVIOUS_FRONTEND_URL=$(existing FRONTEND_URL)
PREVIOUS_FRONTEND_URL="${PREVIOUS_FRONTEND_URL:-http://localhost:3000}"
if [ "$SYNC_ON" = "github" ]; then
  echo "Where the dashboard lives, e.g. your Vercel address (https://<name>.vercel.app)."
  echo "Not deployed yet? Keep the default for now and re-run ./setup.sh once you have the address."
fi
read -rp "Public URL the frontend will be served at [$PREVIOUS_FRONTEND_URL]: " FRONTEND_URL
FRONTEND_URL="${FRONTEND_URL:-$PREVIOUS_FRONTEND_URL}"
FRONTEND_URL="${FRONTEND_URL%/}" # strip trailing slash -- must exact-match the browser's Origin header for CORS

step "Deploying Edge Functions and secrets"
supabase secrets set --project-ref "$PROJECT_REF" \
  "ENABLE_BANKING_APP_ID=$EB_APP_ID" \
  "ENABLE_BANKING_PRIVATE_KEY=$EB_PRIVATE_KEY" \
  "FRONTEND_URL=$FRONTEND_URL"
supabase functions deploy --project-ref "$PROJECT_REF" --use-api # bundled remotely: no Docker needed
echo "Edge Functions live."

step "Writing .env files"
# Merge into the existing files (or the .env.example templates on a first run), so values
# setup doesn't manage -- Coinbase keys, GEMINI_MODEL, your own edits -- are kept.
write_env() { # write_env <target> <template>; KEY=value lines on stdin
  local updates
  updates=$(mktemp)
  chmod 600 "$updates"
  cat > "$updates"
  [ -f "$1" ] || cp "$2" "$1"
  node env-file.js merge "$1" "$updates"
  rm -f "$updates"
  chmod 600 "$1"
}

write_env .env .env.example <<EOF
APP_ID=$EB_APP_ID
PRIVATE_KEY_FILE=$EB_PEM_PATH
PRIVATE_KEY=$EB_PRIVATE_KEY_ENV
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SECRET_KEY
GEMINI_API_KEY=$GEMINI_API_KEY
USER_ID=$USER_ID
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VITE_SUPABASE_PROJECT_ID=$PROJECT_REF
VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
FRONTEND_URL=$FRONTEND_URL
FRONTEND_DIR=$FRONTEND_DIR
SYNC_ON=$SYNC_ON
EOF

if [ -d "$FRONTEND_DIR" ]; then
write_env "$FRONTEND_DIR/.env" "$FRONTEND_DIR/.env.example" <<EOF
SUPABASE_PROJECT_ID=$PROJECT_REF
SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_PROJECT_ID=$PROJECT_REF
VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
EOF
else
  echo "No frontend checkout at $FRONTEND_DIR: skipped its .env (Vercel takes the values in its own settings)."
fi
echo "Wrote .env and $FRONTEND_DIR/.env"

if [ "$SYNC_ON" = "github" ]; then
  step "Turning on the sync on GitHub ($REPO)"
  # Values go in on stdin, so they never show up in the process list. Empty ones are skipped.
  gh_secret() {
    [ -n "$2" ] || return 0
    printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null || die "Could not set the GitHub secret $1."
  }
  gh_secret APP_ID "$EB_APP_ID"
  gh_secret PRIVATE_KEY "$EB_PRIVATE_KEY"
  gh_secret SUPABASE_URL "$SUPABASE_URL"
  gh_secret SUPABASE_SECRET_KEY "$SECRET_KEY"
  gh_secret USER_ID "$USER_ID"
  gh_secret GEMINI_API_KEY "$GEMINI_API_KEY"
  gh_secret VAPID_PUBLIC_KEY "$VAPID_PUBLIC"
  gh_secret VAPID_PRIVATE_KEY "$VAPID_PRIVATE"
  gh_secret VAPID_SUBJECT "$(existing VAPID_SUBJECT)"
  gh_secret COINBASE_API_KEY_NAME "$(existing COINBASE_API_KEY_NAME)"
  gh_secret COINBASE_API_PRIVATE_KEY "$(existing COINBASE_API_PRIVATE_KEY)"
  gh variable set SYNC_ON_GITHUB --body true --repo "$REPO" >/dev/null
  # Forks start with Actions off; switch them on, then the workflow itself.
  gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true >/dev/null 2>&1 \
    || echo "Could not switch Actions on: open https://github.com/$REPO/actions and enable them."
  gh workflow enable sync.yml --repo "$REPO" >/dev/null 2>&1 || true
  echo "Secrets and SYNC_ON_GITHUB set. Sync every 6 hours, prompts hourly, bank reminder daily."
fi

step "Closing public sign-ups"
echo "Supabase leaves sign-ups open by default: anyone who finds your project URL could create an account."
echo "Your login already exists, so this switches them off."
signups_closed() {
  [ "$(json_get "$(curl -fsS "$SUPABASE_URL/auth/v1/settings" -H "apikey: $PUBLISHABLE_KEY")" disable_signup)" = "true" ]
}
# Push only this one setting: a config.toml that declares nothing else leaves every other
# remote setting as it is (checked with `supabase config diff`).
if ! signups_closed; then
  SIGNUP_DIR=$(mktemp -d)
  mkdir "$SIGNUP_DIR/supabase"
  printf 'project_id = "myfinances-setup"\n\n[auth]\nenable_signup = false\n' > "$SIGNUP_DIR/supabase/config.toml"
  supabase config push --workdir "$SIGNUP_DIR" --project-ref "$PROJECT_REF" --yes || echo "Could not switch them off automatically."
  rm -rf "$SIGNUP_DIR"
  for _ in 1 2 3 4 5; do signups_closed && break; sleep 2; done # the setting takes a moment to apply
fi
if signups_closed; then
  echo "Sign-ups are off."
else
  echo "Open https://supabase.com/dashboard/project/${PROJECT_REF}/auth/providers"
  echo "  -> User Signups -> turn OFF 'Allow new users to sign up' -> Save"
  read -rp "Press Enter once saved: " _
  signups_closed || echo "WARNING: sign-ups are still open. Switch them off before you share this instance's URL."
fi

step "Almost done"
SIGN_IN_AS="${LOGIN_EMAIL:-your login}"
if [ "$SYNC_ON" = "github" ]; then
  echo "1. Deploy the dashboard: the Deploy button in the my-wealth-view README (Vercel)."
  echo "   Values to paste there: VITE_SUPABASE_URL=$SUPABASE_URL"
  echo "                          VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY"
  echo "                          VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC"
  echo "   Then run ./setup.sh again with its address, so bank linking redirects there."
  echo "2. Open the dashboard, sign in as $SIGN_IN_AS and click 'Connect a bank' on the Accounts page."
  echo "3. Start a sync any time from https://github.com/$REPO/actions (Sync -> Run workflow)."
else
  echo "1. Start the app:      docker compose up -d --build"
  echo "2. Open http://localhost:3000 and sign in as $SIGN_IN_AS"
  echo "3. In the app, click 'Connect a bank' on the Accounts page."
fi
echo
echo "If MyFinances is useful to you, a star on GitHub helps others find it: https://github.com/marcodonghiaa/myfinances"
