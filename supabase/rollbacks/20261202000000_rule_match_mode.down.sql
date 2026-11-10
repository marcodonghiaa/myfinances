-- Rules made as 'word' or 'exact' go back to matching anywhere in the field.
alter table public.category_rules drop constraint if exists category_rules_match_mode_check;
alter table public.category_rules drop column if exists match_mode;
