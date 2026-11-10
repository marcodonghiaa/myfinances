-- Flow-only rules would violate the old check: remove them first.
delete from public.category_rules where set_category is null and set_transaction_type is null;
alter table public.category_rules drop constraint if exists at_least_one_action;
alter table public.category_rules add constraint at_least_one_action
  check (set_category is not null or set_transaction_type is not null);
