#!/bin/bash
# Guided self-host setup: creates (or links) a Supabase project, applies the
# schema, deploys the bank-linking Edge Functions, and writes both apps'
# .env files. Run once per self-hosted instance.
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

step "Checking prerequisites"
command -v supabase >/dev/null || die "supabase CLI not found. Install: brew install supabase/tap/supabase"
command -v node >/dev/null || die "node not found. Install Node 18+."
command -v npx >/dev/null || die "npx not found (ships with Node)."
[ -d "$FRONTEND_DIR" ] || die "Frontend repo not found at $FRONTEND_DIR. Clone it as a sibling directory, or set FRONTEND_DIR=/path/to/my-wealth-view."
echo "OK: supabase CLI, node, frontend repo at $FRONTEND_DIR"

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
read -rp "Use an existing Supabase project? [y/N] " USE_EXISTING
if [[ "$USE_EXISTING" =~ ^[Yy]$ ]]; then
  read -rp "Project ref (20-char id from the dashboard URL): " PROJECT_REF
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
  echo "Created project $PROJECT_REF -- DB password: $DB_PASSWORD (save this, it's shown once)"
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

step "Enable Banking (manual signup required)"
echo "If you haven't already: sign up at https://enablebanking.com, create an"
echo "application (free Restricted Production tier), and download its PSD2 private key."
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

step "Generating VAPID keys for push notifications"
VAPID_OUT=$(npx --yes web-push generate-vapid-keys 2>&1)
VAPID_PUBLIC=$(echo "$VAPID_OUT" | grep -A1 "Public Key" | tail -1 | tr -d '[:space:]')
VAPID_PRIVATE=$(echo "$VAPID_OUT" | grep -A1 "Private Key" | tail -1 | tr -d '[:space:]')
[ -n "$VAPID_PUBLIC" ] && [ -n "$VAPID_PRIVATE" ] || die "Could not parse VAPID keys from web-push output."
echo "Generated."

step "Gemini API key (for AI transaction categorization)"
echo "Get one free at https://aistudio.google.com/apikey"
read -rp "GEMINI_API_KEY: " GEMINI_API_KEY

step "Frontend URL (for bank-linking redirects)"
read -rp "Public URL the frontend will be served at [https://localhost:3000]: " FRONTEND_URL
FRONTEND_URL="${FRONTEND_URL:-https://localhost:3000}"

step "Deploying Edge Functions and secrets"
supabase secrets set --project-ref "$PROJECT_REF" \
  "ENABLE_BANKING_APP_ID=$EB_APP_ID" \
  "ENABLE_BANKING_PRIVATE_KEY=$EB_PRIVATE_KEY" \
  "FRONTEND_URL=$FRONTEND_URL"
supabase functions deploy --project-ref "$PROJECT_REF"
echo "Edge Functions live."

step "Writing .env files"
cat > .env <<EOF
APP_ID=$EB_APP_ID
PRIVATE_KEY_FILE=$EB_PEM_PATH
PRIVATE_KEY=$EB_PRIVATE_KEY_ENV
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SECRET_KEY
SESSION_VALID_UNTIL=90
GEMINI_API_KEY=$GEMINI_API_KEY
USER_ID=
COINBASE_API_KEY_NAME=
COINBASE_API_PRIVATE_KEY=
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:you@example.com
VITE_SUPABASE_PROJECT_ID=$PROJECT_REF
VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
VITE_SUPABASE_URL=$SUPABASE_URL
FRONTEND_DIR=$FRONTEND_DIR
EOF
chmod 600 .env

cat > "$FRONTEND_DIR/.env" <<EOF
SUPABASE_PROJECT_ID=$PROJECT_REF
SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_PROJECT_ID=$PROJECT_REF
VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
VITE_SUPABASE_URL=$SUPABASE_URL
EOF
echo "Wrote .env and $FRONTEND_DIR/.env"

step "Almost done"
echo "1. Start the app:      docker compose up -d --build"
echo "2. Open http://localhost:3000 and sign up (creates your Supabase Auth user)"
echo "3. Find your user id:  Supabase Dashboard -> Authentication -> Users"
echo "4. Put it in .env:     USER_ID=<that id>"
echo "5. Restart the sync container so it picks it up:  docker compose restart sync"
echo "6. In the app, click 'Connect a bank' on the Accounts page."
