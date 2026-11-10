-- Removes the tag list function and index. The note and tags columns stay, with what users wrote:
-- v_transactions_eur and the views built on it read them, and the previous dashboard ignores them.
drop function if exists public.my_transaction_tags();
drop index if exists public.transactions_tags_idx;
