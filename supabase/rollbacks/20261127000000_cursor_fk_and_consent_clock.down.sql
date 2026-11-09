-- Rollback of 20261127000000_cursor_fk_and_consent_clock. The orphan cursors it deleted are not
-- restored (they pointed at accounts that no longer exist).
drop trigger if exists trg_pending_consent_server_time on public.pending_bank_consents;
drop function if exists public.pending_consent_server_time();
alter table public.sync_cursors drop constraint if exists sync_cursors_account_uid_fkey;
