-- Issue #141: the 200-character cap on rule text (20261206) was a NOT VALID check, so a rule saved
-- before it with longer text refused every later change, even ones that leave the text alone
-- (marking income regular, re-sorting priorities). Check the text only when it is new or changed:
-- same limit, same name and error code (23514) as before.
create or replace function public.category_rules_match_text_length()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (tg_op = 'INSERT' or new.match_text is distinct from old.match_text)
     and char_length(new.match_text) not between 1 and 200 then
    raise exception 'rule text must be 1 to 200 characters'
      using errcode = 'check_violation', constraint = 'category_rules_match_text_length';
  end if;
  return new;
end $$;

drop trigger if exists category_rules_match_text_length on public.category_rules;
create trigger category_rules_match_text_length
  before insert or update of match_text on public.category_rules
  for each row execute function public.category_rules_match_text_length();

alter table public.category_rules drop constraint if exists category_rules_match_text_length;
