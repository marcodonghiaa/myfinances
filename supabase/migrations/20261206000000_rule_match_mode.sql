-- How a rule's text must appear: 'contains' (anywhere, the old behaviour, kept for existing
-- rules), 'word' (on its own, so "bar" no longer matches "Barclays") or 'exact' (the whole field).
alter table public.category_rules add column if not exists match_mode text not null default 'contains';
alter table public.category_rules drop constraint if exists category_rules_match_mode_check;
alter table public.category_rules add constraint category_rules_match_mode_check
  check (match_mode in ('contains', 'word', 'exact'));
-- Rule text up to 200 characters (a SEPA name is at most 70, a description 140): a huge rule
-- would become a huge regex in the sync, which every user of the instance waits on. NOT VALID
-- leaves existing rows alone; new and changed rules are checked.
alter table public.category_rules drop constraint if exists category_rules_match_text_length;
alter table public.category_rules add constraint category_rules_match_text_length
  check (char_length(match_text) between 1 and 200) not valid;
