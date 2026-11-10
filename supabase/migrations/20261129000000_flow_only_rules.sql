-- A rule may now only set the flow (category_rules.set_flow_type, e.g. "It's a transfer" from
-- the dashboard's To review list). Some databases carry a check that a rule sets a category or
-- a type; widen it so flow-only rules can be saved, and add it where it was missing.
alter table public.category_rules drop constraint if exists at_least_one_action;
alter table public.category_rules add constraint at_least_one_action
  check (set_category is not null or set_transaction_type is not null or set_flow_type is not null);
