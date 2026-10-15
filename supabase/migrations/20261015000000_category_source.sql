-- Records who set a transaction's category so rules can be re-applied without
-- overwriting hand edits. 'ai' and 'rule' are written by the sync scripts, 'manual'
-- by the trigger below whenever a signed-in user changes the category, and 'legacy'
-- marks categories that existed before this column (provenance unknown, so they are
-- treated as protected).
alter table public.transactions
  add column category_source text
  check (category_source in ('ai', 'rule', 'manual', 'legacy'));

update public.transactions
  set category_source = 'legacy'
  where category is not null and category_source is null;

create or replace function public.mark_manual_category()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.category_source := 'manual';
  return new;
end;
$function$;

-- Trigger function itself must not be directly callable via RPC.
revoke execute on function public.mark_manual_category() from public, anon, authenticated;

drop trigger if exists trg_mark_manual_category on public.transactions;
create trigger trg_mark_manual_category
  before update of category on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text and new.category is distinct from old.category)
  execute function public.mark_manual_category();
