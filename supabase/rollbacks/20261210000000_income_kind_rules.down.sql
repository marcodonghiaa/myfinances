-- Rules that only marked income as regular or one-off have no other action: remove them first.
delete from public.category_rules
 where set_category is null and set_transaction_type is null and set_flow_type is null;
alter table public.category_rules drop constraint if exists at_least_one_action;
alter table public.category_rules add constraint at_least_one_action
  check (set_category is not null or set_transaction_type is not null or set_flow_type is not null);
alter table public.category_rules drop column if exists set_income_kind;
