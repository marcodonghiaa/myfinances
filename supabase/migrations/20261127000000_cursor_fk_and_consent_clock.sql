-- 1. sync_cursors.account_uid had no foreign key, so deleting an account (or a user) left its
--    cursor behind. Drop cursors whose account is already gone (they are never read again), then
--    tie the rest to accounts so they go with them. NOT VALID + VALIDATE: no long write lock.
delete from public.sync_cursors c
where not exists (select 1 from public.accounts a where a.uid = c.account_uid);
alter table public.sync_cursors
  add constraint sync_cursors_account_uid_fkey
  foreign key (account_uid) references public.accounts (uid) on delete cascade not valid;
alter table public.sync_cursors validate constraint sync_cursors_account_uid_fkey;

-- 2. A user could insert their own pending_bank_consents row with any created_at and so stretch
--    the 15-minute window. The clock is now the database's, whatever the insert says.
create function public.pending_consent_server_time()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;
create trigger trg_pending_consent_server_time
  before insert or update of created_at on public.pending_bank_consents
  for each row execute function public.pending_consent_server_time();
