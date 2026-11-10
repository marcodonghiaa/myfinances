-- How a rule's text must appear: 'contains' (anywhere, the old behaviour, kept for existing
-- rules), 'word' (on its own, so "bar" no longer matches "Barclays") or 'exact' (the whole field).
alter table public.category_rules add column if not exists match_mode text not null default 'contains';
alter table public.category_rules drop constraint if exists category_rules_match_mode_check;
alter table public.category_rules add constraint category_rules_match_mode_check
  check (match_mode in ('contains', 'word', 'exact'));
