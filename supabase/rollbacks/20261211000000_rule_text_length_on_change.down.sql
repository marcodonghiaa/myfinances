drop trigger if exists category_rules_match_text_length on public.category_rules;
drop function if exists public.category_rules_match_text_length();
alter table public.category_rules drop constraint if exists category_rules_match_text_length;
alter table public.category_rules add constraint category_rules_match_text_length
  check (char_length(match_text) between 1 and 200) not valid;
