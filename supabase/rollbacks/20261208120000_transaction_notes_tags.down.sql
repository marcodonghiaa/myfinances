-- Rollback of 20261208120000_transaction_notes_tags: drops the tag suggestions and the limits on
-- notes and tags. The note and tags columns (and the view's two last columns) stay, with whatever
-- users wrote: other views are built on v_transactions_eur, so its columns can't be removed
-- without rebuilding them, and an older dashboard ignores columns it doesn't ask for.
drop function if exists public.my_transaction_tags();
alter table public.transactions
  drop constraint if exists transactions_note_length,
  drop constraint if exists transactions_tags_ok;
drop function if exists public.transaction_tags_ok(text[]);
