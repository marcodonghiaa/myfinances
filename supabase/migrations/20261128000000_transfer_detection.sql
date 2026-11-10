-- Transfers between your own accounts are never spend or income. Every flow now remembers who
-- decided it (flow_source), and what you decided never changes by itself:
--   user        you (dashboard, manual rows, Splitwise import, a confirmed or rejected pair)
--   rule        one of your rules (category_rules.set_flow_type) or a merchant you set to Transfer
--   own_account the counterparty's IBAN is one of your own accounts (own_counterparty)
--   pair        post-sync paired it with the opposite movement on another of your accounts
--   bank        the bank's code says it (EXCHANGE, TOPUP)
--   default     the direction (debit spend, credit income)
-- post-sync only fills or changes rows whose source is not 'user'.

alter table public.transactions
  add column if not exists flow_source text
    check (flow_source in ('user', 'rule', 'own_account', 'pair', 'bank', 'default')),
  -- Whether the counterparty's account is one of yours (null = the bank sent no IBAN).
  -- Only the yes/no is kept, never the other account's number.
  add column if not exists own_counterparty boolean;

-- Every flow decided so far stays as it is.
update public.transactions set flow_source = 'user' where flow_type is not null and flow_source is null;

-- A flow changed by a signed-in user (dashboard edits, add_manual_transaction, Splitwise
-- import and undo) is theirs: it is never reclassified. Cleared flows go back to post-sync.
create function public.flow_source_user() returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' or new.flow_type is distinct from old.flow_type then
    new.flow_source := case when new.flow_type is null then null else 'user' end;
  end if;
  return new;
end;
$$;
revoke execute on function public.flow_source_user() from public, anon, authenticated;

create trigger trg_flow_source_user
  before insert or update of flow_type on public.transactions
  for each row
  when (auth.role() = 'authenticated'::text)
  execute function public.flow_source_user();

-- "Count as" for the future: rows matching the rule count as a transfer, or (spend, income)
-- as not a transfer, following their direction.
alter table public.category_rules
  add column if not exists set_flow_type text check (set_flow_type in ('spend', 'income', 'transfer'));

-- A debit on one account and the matching credit on another, paired by post-sync. You confirm
-- (flow stays transfer) or reject it (both rows count by direction again) with
-- resolve_transfer_pair. Written only by the service role and that function.
create table public.transfer_pairs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  out_account_uid uuid not null,
  out_ref text not null,
  in_account_uid uuid not null,
  in_ref text not null,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  foreign key (out_account_uid, out_ref) references public.transactions (account_uid, entry_reference) on delete cascade,
  foreign key (in_account_uid, in_ref) references public.transactions (account_uid, entry_reference) on delete cascade
);
-- A transaction is in at most one pair that is not rejected.
create unique index transfer_pairs_out_key on public.transfer_pairs (out_account_uid, out_ref) where status <> 'rejected';
create unique index transfer_pairs_in_key on public.transfer_pairs (in_account_uid, in_ref) where status <> 'rejected';
create index transfer_pairs_user_id_idx on public.transfer_pairs (user_id);

alter table public.transfer_pairs enable row level security;
revoke all on table public.transfer_pairs from anon, authenticated;
grant select on table public.transfer_pairs to authenticated;
create policy "Users can view own transfer pairs" on public.transfer_pairs
  for select to authenticated using ((select auth.uid()) = user_id);

-- Confirm (p_keep) or reject a pair. A confirmed pair can still be rejected later; a rejected
-- one is final (post-sync never proposes it again).
create function public.resolve_transfer_pair(p_pair uuid, p_keep boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_pair public.transfer_pairs;
begin
  select * into v_pair from public.transfer_pairs
   where id = p_pair and user_id = auth.uid()
   for update;
  if not found then
    raise exception 'Transfer pair not found';
  end if;
  if v_pair.status = 'rejected' then
    raise exception 'Transfer pair already rejected';
  end if;

  update public.transfer_pairs set status = case when p_keep then 'confirmed' else 'rejected' end
   where id = p_pair;

  update public.transactions t
     set flow_type = case
           when p_keep then 'transfer'
           when t.credit_debit_indicator = 'DBIT' then 'spend'
           else 'income'
         end,
         flow_source = 'user'
   where t.user_id = v_pair.user_id
     and ((t.account_uid = v_pair.out_account_uid and t.entry_reference = v_pair.out_ref)
       or (t.account_uid = v_pair.in_account_uid and t.entry_reference = v_pair.in_ref));
end;
$$;
revoke execute on function public.resolve_transfer_pair(uuid, boolean) from public, anon;
grant execute on function public.resolve_transfer_pair(uuid, boolean) to authenticated;
