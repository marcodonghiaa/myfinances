-- Where each bank account's transaction sync got to. It lived in a local file (last-sync.json),
-- which a run on a fresh machine (GitHub Actions, a new container) doesn't have. Only the sync
-- scripts read and write it, with the service role: RLS is on with no policies, so users can't.
create table public.sync_cursors (
  account_uid uuid primary key,
  last_synced date not null,
  updated_at timestamptz not null default now()
);

alter table public.sync_cursors enable row level security;
