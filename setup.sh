#!/bin/bash
# Guided self-host setup: creates (or links) a Supabase project, applies the
# schema, deploys the bank-linking Edge Functions, and writes both apps'
# .env files. Safe to run again: it reuses the values already in .env, only
# asks for what's missing, and applies any new migrations and functions.
#
# Forgot your password? ./setup.sh --reset-password
# Bank linking sends you to the wrong address? ./setup.sh --dashboard-url https://<its address>
# (normally unneeded: the dashboard registers its own address when you sign in)
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
# Any failing exit (die, or a command that stops the script under set -e) ends with the next step.
trap '[ $? -eq 0 ] || echo "Fix that, then run ./setup.sh again: answers already saved in .env are reused." >&2' EXIT
# Value already in this install's .env ('' when missing), so a re-run doesn't ask again.
existing() { node env-file.js get .env "$1"; }
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

# Point bank linking at the deployed dashboard without re-running the whole setup.
if [ "${1:-}" = "--dashboard-url" ]; then
  SUPABASE_URL=$(existing SUPABASE_URL)
  [ -n "$SUPABASE_URL" ] || die "No SUPABASE_URL in .env. Run ./setup.sh first."
  REF=${SUPABASE_URL#https://}; REF=${REF%%.*}
  # It prints why on stderr. Exit 3 is only a warning: the address was typed deliberately, so use it.
  ORIGIN=$(node frontend-url.js "${2:-}") || [ $? -eq 3 ] || exit 1
  supabase secrets set --project-ref "$REF" "FRONTEND_URL=$ORIGIN" >/dev/null \
    || die "Could not save FRONTEND_URL in Supabase (not logged in? run: supabase login)."
  supabase functions deploy --project-ref "$REF" --use-api || die "Could not redeploy the Edge Functions."
  write_env .env .env.example <<EOF
FRONTEND_URL=$ORIGIN
EOF
  echo "Done! Open $ORIGIN"
  exit 0
fi

bold "MyFinances setup: 8 short steps, about 15-30 minutes (most of it on Enable Banking's site)."
echo "Every question shows a recommended answer: press Enter to accept it."
echo "Your answers are saved as you go, so you can stop and run ./setup.sh again any time."
echo
echo "  1. Where the sync runs (Enter: GitHub Actions)"
echo "  2. GitHub login (GitHub option only; opens your browser)"
echo "  3. Supabase login (opens your browser, free account)"
echo "  4. Supabase project (Enter: a fresh free one)"
echo "  5. Your login for the app (an email and a password you choose)"
echo "  6. Enable Banking (you leave the terminal: sign-up and key on their site, about 10 minutes)"
echo "  7. Gemini API key (recommended, free; Enter skips)"
echo "  8. Put the dashboard online on Vercel (about 5 minutes; setup waits for your first sign-in)"

step "Where should the sync run?"
echo "  1) GitHub Actions: free, no computer has to stay on. Needs your fork of this repo and the GitHub CLI (gh)."
echo "  2) Docker on this computer: the sync runs only while it is on."
PREVIOUS_SYNC_ON=$(existing SYNC_ON)
if [ "$PREVIOUS_SYNC_ON" = "docker" ]; then
  DEFAULT_CHOICE=2; echo "Press Enter: keeps Docker, your choice last time."
else
  DEFAULT_CHOICE=1; echo "New here? Press Enter: GitHub Actions, nothing to keep running."
fi
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
  if [ "${CODESPACES:-}" = "true" ]; then
    # A Codespace's built-in token can't write repository secrets: sign gh in as you instead.
    unset GITHUB_TOKEN
    gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow
  else
    gh auth status >/dev/null 2>&1 || gh auth login
  fi
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || die "This folder is not a GitHub repository. Clone myfinances (or open it in Codespaces) and run setup there."
  # The sync runs in a repo you own. Opened from someone else's repo (e.g. Codespaces on the
  # original), fork it to your account and use the fork.
  if [ "$(gh repo view "$REPO" --json viewerPermission --jq .viewerPermission)" != "ADMIN" ]; then
    echo "$REPO isn't yours: the sync will run in your own fork of it."
    echo "Press Enter: forks it (recommended)."
    read -rp "Fork it to your GitHub account now? [Y/n] " DO_FORK
    [[ "$DO_FORK" =~ ^[Nn]$ ]] && die "Fork $REPO on GitHub, then run setup from your fork."
    gh repo fork "$REPO" --clone=false --default-branch-only >/dev/null 2>&1 || true # fine if it exists
    REPO="$(gh api user --jq .login)/${REPO#*/}"
    [ "$(gh repo view "$REPO" --json viewerPermission --jq .viewerPermission 2>/dev/null)" = "ADMIN" ] \
      || die "Could not find your fork $REPO. Fork it on GitHub, then run setup again."
  fi
  if [ "$REPO" = "marcodonghiaa/myfinances" ]; then
    echo "This is the original public repo: the sync would run here and its logs are public."
    read -rp "Continue anyway? [y/N] " UPSTREAM_OK
    [[ "$UPSTREAM_OK" =~ ^[Yy]$ ]] || die "Run setup from your own fork of $REPO."
  fi
  echo "OK: supabase CLI, node, GitHub CLI, your repo $REPO"
fi

json_get() {
  # json_get '<json>' 'key' -- tiny JSON field reader, avoids adding a jq dependency
  node -e "const d=JSON.parse(process.argv[1]); const v=process.argv[2].split('.').reduce((o,k)=>o?.[k], d); if (Array.isArray(v)) console.log(JSON.stringify(v)); else console.log(v ?? '')" "$1" "$2"
}

step "Supabase login"
if ! supabase projects list >/dev/null 2>&1; then
  echo "Opening your browser to sign in to Supabase (free account). Nothing to type here; come back when it says you are logged in."
  supabase login
fi

step "Supabase project"
PREVIOUS_URL=$(existing SUPABASE_URL)
PROJECT_REF=""
if [ -n "$PREVIOUS_URL" ]; then
  PREVIOUS_REF=$(echo "$PREVIOUS_URL" | sed -E 's#https://([a-z0-9]+)\.supabase\.co/?#\1#')
  echo "Press Enter: keeps the project and everything already in it."
  read -rp "Keep using project $PREVIOUS_REF from .env? [Y/n] " KEEP_PROJECT
  [[ "$KEEP_PROJECT" =~ ^[Nn]$ ]] || PROJECT_REF="$PREVIOUS_REF"
fi
if [ -n "$PROJECT_REF" ]; then
  echo "Using project $PROJECT_REF."
else
echo "New here? Press Enter: creates a fresh free project."
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
  ORG_COUNT=$(json_get "$ORGS_JSON" length)
  if [ "$ORG_COUNT" = "0" ]; then
    # A brand-new Supabase account has no organization yet, and projects live in one.
    ORG_NAME="$(gh api user --jq .login 2>/dev/null || whoami)'s org"
    echo "No Supabase organization yet: creating \"$ORG_NAME\"."
    ORG_JSON=$(supabase orgs create "$ORG_NAME" --output json) \
      || die "Could not create a Supabase organization (see message above). Create one at supabase.com/dashboard."
    ORG_ID=$(json_get "$ORG_JSON" id)
  else
    ORG_PICK=1
    if [ "$ORG_COUNT" -gt 1 ] 2>/dev/null; then
      node -e "JSON.parse(process.argv[1]).forEach((o, i) => console.log('  ' + (i + 1) + ') ' + o.name))" "$ORGS_JSON"
      echo "Press Enter: uses the first one."
      read -rp "Organization [1]: " ORG_PICK
      ORG_PICK="${ORG_PICK:-1}"
      [[ "$ORG_PICK" =~ ^[0-9]+$ ]] && [ "$ORG_PICK" -ge 1 ] && [ "$ORG_PICK" -le "$ORG_COUNT" ] \
        || die "Choose a number from 1 to $ORG_COUNT."
    fi
    ORG_ID=$(json_get "$ORGS_JSON" "$((ORG_PICK - 1)).id")
    ORG_NAME=$(json_get "$ORGS_JSON" "$((ORG_PICK - 1)).name")
  fi
  [ -n "$ORG_ID" ] || die "No Supabase organization found. Create one at supabase.com/dashboard first."
  echo "Using organization: $ORG_NAME ($ORG_ID)"
  echo "Press Enter: any name works, only you see it."
  read -rp "New project name [finance-app]: " PROJECT_NAME
  PROJECT_NAME="${PROJECT_NAME:-finance-app}"
  DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
  echo "Press Enter for Europe; elsewhere pick the closest, e.g. us-east-1 or ap-southeast-1."
  read -rp "Region [eu-central-1]: " REGION
  REGION="${REGION:-eu-central-1}"
  echo "Creating project (this takes a minute)..."
  CREATE_JSON=$(supabase projects create "$PROJECT_NAME" --org-id "$ORG_ID" --db-password "$DB_PASSWORD" --region "$REGION" --output json) \
    || die "Could not create the project (see message above). Free plans allow 2 active projects per organization: pause or delete one at supabase.com/dashboard, or pick another organization."
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
supabase db push --linked --yes
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
echo "This email and password are what you will sign in to your dashboard with. Any email you can read works."
echo "Save the password in your password manager: setup does not show or store it."
read -rp "Email: " LOGIN_EMAIL
read -rsp "Password (6+ characters, not shown): " LOGIN_PASSWORD
echo
# Credentials go in as environment variables so they never appear in the process list.
USER_ID=$(SETUP_URL="$SUPABASE_URL" SETUP_SECRET_KEY="$SECRET_KEY" SETUP_EMAIL="$LOGIN_EMAIL" SETUP_PASSWORD="$LOGIN_PASSWORD" node first-user.js) || die "Could not create your login (see message above)."
unset LOGIN_PASSWORD
echo "Login ready for $LOGIN_EMAIL."
fi
# Push services use this contact address; the .env.example placeholder would be rejected by some.
VAPID_SUBJECT=$(existing VAPID_SUBJECT)
if { [ -z "$VAPID_SUBJECT" ] || [ "$VAPID_SUBJECT" = "mailto:you@example.com" ]; } && [ -n "${LOGIN_EMAIL:-}" ]; then
  VAPID_SUBJECT="mailto:$LOGIN_EMAIL"
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
echo "The APP_ID is the long id shown for your app under API applications."
read -rp "Enable Banking APP_ID: " EB_APP_ID
if [ "${CODESPACES:-}" = "true" ]; then
  echo "In Codespaces: drag the .pem from your Downloads onto the file list on the left, then type its name."
fi
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
# eb-check.js exits 1 for an Inactive app (fixed in EB's panel, so check again), 2 for a wrong APP_ID/.pem.
until APP_ID="$EB_APP_ID" PRIVATE_KEY="$EB_PRIVATE_KEY_ENV" node eb-check.js; do
  [ $? -eq 1 ] || die "Re-run ./setup.sh with the right APP_ID and .pem (if they came from .env, delete its APP_ID, PRIVATE_KEY and PRIVATE_KEY_FILE lines first)."
  read -rp "Fix it, then press Enter to check again (Ctrl-C to stop): " _
done

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
echo "Recommended: paste a key (free). What you type is not shown."
GEMINI_API_KEY=$(existing GEMINI_API_KEY)
if [ -n "$GEMINI_API_KEY" ]; then
  echo "Using the key from .env."
else
  read -rsp "GEMINI_API_KEY (not shown; Enter to skip): " GEMINI_API_KEY
  echo
fi

step "Deploying Edge Functions and secrets"
# The dashboard registers its own address when you sign in, so FRONTEND_URL is only kept (never
# asked for) on installs that already have one, or that ran --dashboard-url.
FRONTEND_URL=$(existing FRONTEND_URL)
SECRETS=("ENABLE_BANKING_APP_ID=$EB_APP_ID" "ENABLE_BANKING_PRIVATE_KEY=$EB_PRIVATE_KEY")
[ -z "$FRONTEND_URL" ] || SECRETS+=("FRONTEND_URL=$FRONTEND_URL")
supabase secrets set --project-ref "$PROJECT_REF" "${SECRETS[@]}"
supabase functions deploy --project-ref "$PROJECT_REF" --use-api # bundled remotely: no Docker needed
echo "Edge Functions live."

step "Writing .env files"
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
VAPID_SUBJECT=$VAPID_SUBJECT
VITE_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
FRONTEND_URL=$FRONTEND_URL
FRONTEND_DIR=$FRONTEND_DIR
SYNC_ON=$SYNC_ON
EOF

if [ -d "$FRONTEND_DIR" ]; then
write_env "$FRONTEND_DIR/.env" "$FRONTEND_DIR/.env.example" <<EOF
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
  gh_secret VAPID_SUBJECT "$VAPID_SUBJECT"
  gh_secret COINBASE_API_KEY_NAME "$(existing COINBASE_API_KEY_NAME)"
  gh_secret COINBASE_API_PRIVATE_KEY "$(existing COINBASE_API_PRIVATE_KEY)"
  gh variable set SYNC_ON_GITHUB --body true --repo "$REPO" >/dev/null
  # Forks start with Actions off; switch them on, then the workflow itself.
  gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true >/dev/null 2>&1 \
    || echo "Could not switch Actions on: open https://github.com/$REPO/actions and enable them."
  gh workflow enable sync.yml --repo "$REPO" >/dev/null 2>&1 || true
  # Your fork is public, and so are its Actions logs: keep them 1 day instead of GitHub's 90.
  gh api -X PUT "repos/$REPO/actions/permissions/artifact-and-log-retention" -F days=1 >/dev/null 2>&1 \
    || echo "WARNING: set Artifact and log retention to 1 day at https://github.com/$REPO/settings/actions"
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
# The dashboard tells the database its own address on your first sign-in (table dashboard_origins).
# Prefer an https address over a localhost one (https sorts after http:).
registered_origin() {
  json_get "$(curl -fsS "$SUPABASE_URL/rest/v1/dashboard_origins?select=origin&order=origin.desc&limit=1" \
    -H "apikey: $SECRET_KEY" 2>/dev/null)" 0.origin 2>/dev/null || true
}
DASHBOARD_URL=""
if [ "$SYNC_ON" = "docker" ]; then
  DASHBOARD_URL="http://localhost:3000"
  echo "1. Start the app:      docker compose up -d --build"
  echo "2. Open $DASHBOARD_URL and sign in as $SIGN_IN_AS"
  echo "3. In the app, click 'Connect a bank' on the Accounts page."
else
  DASHBOARD_URL=$(registered_origin)
  if [ -z "$DASHBOARD_URL" ]; then
    # Public values only: the publishable key and VAPID public key are meant for browsers.
    printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_PUBLISHABLE_KEY=%s\nVITE_VAPID_PUBLIC_KEY=%s\n' \
      "$SUPABASE_URL" "$PUBLISHABLE_KEY" "$VAPID_PUBLIC" > dashboard-values.txt
    echo "Put the dashboard online: the Deploy button in the my-wealth-view README (Vercel)."
    echo "Paste these three values there (also saved in dashboard-values.txt):"
    echo
    cat dashboard-values.txt
    echo
    echo "Then open the dashboard and sign in as $SIGN_IN_AS. I'll wait for that first sign-in (up to 15 minutes);"
    echo "press Enter to skip waiting: it finishes by itself, you do not need to run setup again."
    # Only on a terminal: without one, read returns at once and the loop would spin.
    if [ -t 0 ]; then
      for _ in $(seq 1 180); do
        DASHBOARD_URL=$(registered_origin)
        [ -z "$DASHBOARD_URL" ] || break
        read -t 5 -r _ && break # Enter: stop waiting
      done
    fi
  fi
  if [ -n "$DASHBOARD_URL" ]; then
    echo "1. In the dashboard, click 'Connect a bank' on the Accounts page."
  else
    echo "1. Open the dashboard, sign in as $SIGN_IN_AS and click 'Connect a bank' on the Accounts page."
  fi
  echo "2. Start a sync any time from https://github.com/$REPO/actions (Sync -> Run workflow)."
fi
if [ "${CODESPACES:-}" = "true" ]; then
  echo
  echo "This Codespace now holds your keys (.env and the .pem). Once you're done, delete it:"
  echo "https://github.com/codespaces -> ... next to this one -> Delete. Your setup lives on in Supabase and GitHub."
fi
echo
echo "If MyFinances is useful to you, a star on GitHub helps others find it: https://github.com/marcodonghiaa/myfinances"
[ -z "$DASHBOARD_URL" ] || echo "Done! Open $DASHBOARD_URL and sign in as $SIGN_IN_AS"
