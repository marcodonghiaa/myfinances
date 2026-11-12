-- A rule can say whether matching income is regular (salary, a steady client) or one-off
-- (category_rules.set_income_kind). The dashboard decides regular income by itself (a sender
-- paying in at least 3 of the last 6 months); this rule overrides that guess either way.
-- Read only by the dashboard: the sync's rule readers each select their own action column, so a
-- rule that sets only this is never applied as a category, type or flow rule.
alter table public.category_rules
  add column if not exists set_income_kind text check (set_income_kind in ('regular', 'one_off'));

alter table public.category_rules drop constraint if exists at_least_one_action;
alter table public.category_rules add constraint at_least_one_action
  check (set_category is not null or set_transaction_type is not null or set_flow_type is not null
         or set_income_kind is not null);
