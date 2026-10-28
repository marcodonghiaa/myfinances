-- The dashboard registers its own address on the owner's first sign-in, so setup.sh no longer asks for it.
-- The Edge Functions allow these origins in CORS, and bank-consent-callback sends the browser back to the
-- origin that started the link (stored on the pending consent row, never taken from the callback URL).
-- Safe to re-run (if not exists, create or replace).

create table if not exists public.dashboard_origins (
  origin text primary key,
  created_at timestamptz not null default now()
);
-- No policies: only the service role (Edge Functions) and register_dashboard_origin() touch it.
alter table public.dashboard_origins enable row level security;
revoke all on table public.dashboard_origins from anon, authenticated;

alter table public.pending_bank_consents add column if not exists origin text;

-- Takes no argument on purpose: the origin is the browser's own Origin header, which page script cannot
-- forge, so a page can only register the site it is served from. Owner only (the first user: setup creates
-- exactly one and closes sign-ups). Mirrors frontend-url.js: https, or http://localhost:<port>; Vercel
-- per-deployment and per-branch hosts are refused because they stop working on the next deploy.
-- Returns added | exists | rejected | full | not_owner | no_origin.
create or replace function public.register_dashboard_origin()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  owner_id uuid;
  hdr text;
begin
  select id into owner_id from auth.users order by created_at, id limit 1;
  if caller is null or owner_id is distinct from caller then return 'not_owner'; end if;

  hdr := lower(nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'origin', ''));
  if hdr is null then return 'no_origin'; end if;

  if length(hdr) > 255
     or not (hdr ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' or hdr ~ '^http://localhost:[0-9]{1,5}$')
     or hdr ~ '-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app(:[0-9]+)?$'
     or hdr ~ '-git-[a-z0-9-]+\.vercel\.app(:[0-9]+)?$' then
    return 'rejected';
  end if;

  if exists (select 1 from public.dashboard_origins where origin = hdr) then return 'exists'; end if;
  if (select count(*) from public.dashboard_origins) >= 5 then return 'full'; end if;
  insert into public.dashboard_origins (origin) values (hdr) on conflict do nothing;
  return 'added';
end;
$$;

revoke all on function public.register_dashboard_origin() from public, anon;
grant execute on function public.register_dashboard_origin() to authenticated;
