-- Changing how many you hold (or marking a holding sold) left net worth on the old value until
-- the next price sync wrote a snapshot, and for good where the price sync doesn't run: net worth
-- is built from the latest snapshot of each holding. set_holding_quantity changes the quantity
-- and, when the holding has a price, writes today's snapshot from its latest price, so net worth
-- moves at once. Past snapshots stay, so past net worth is unchanged.
--
-- Security definer because users cannot write snapshots; every statement is pinned to auth.uid().
-- p_kind 'stock': p_key is the ISIN. p_kind 'crypto': p_key is the coin symbol, p_source its source.
-- Returns the number of holdings changed (0 when there was none).
create function public.set_holding_quantity(
  p_kind text, p_key text, p_quantity numeric, p_source text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_count integer;
  v_price numeric;
  v_currency text;
  v_rate numeric;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'quantity must be zero or more';
  end if;

  if p_kind = 'stock' then
    update portfolio_holdings set shares = p_quantity where user_id = v_uid and isin = p_key;
    get diagnostics v_count = row_count;
    if v_count = 0 then return 0; end if;

    select price, currency into v_price, v_currency from portfolio_snapshots
    where user_id = v_uid and isin = p_key order by snapshot_date desc limit 1;
    if v_price is null then return v_count; end if;
    v_rate := case when v_currency = 'EUR' then 1 else (
      select rate_to_eur from fx_rates where currency = v_currency order by date desc limit 1
    ) end;

    insert into portfolio_snapshots (user_id, isin, snapshot_date, price, currency, value_native, value_eur)
    values (v_uid, p_key, v_today, v_price, v_currency, v_price * p_quantity, v_price * p_quantity * v_rate)
    on conflict (user_id, isin, snapshot_date) do update set
      value_native = excluded.value_native, value_eur = excluded.value_eur;

  elsif p_kind = 'crypto' then
    if p_source is null then
      raise exception 'crypto needs a source';
    end if;
    update crypto_holdings set amount = p_quantity
    where user_id = v_uid and asset_symbol = p_key and source = p_source;
    get diagnostics v_count = row_count;
    if v_count = 0 then return 0; end if;

    select price_usd into v_price from crypto_snapshots
    where user_id = v_uid and asset_symbol = p_key and source = p_source
    order by snapshot_date desc limit 1;
    if v_price is null then return v_count; end if;
    v_rate := (select rate_to_eur from fx_rates where currency = 'USD' order by date desc limit 1);

    insert into crypto_snapshots (user_id, asset_symbol, source, snapshot_date, amount, price_usd, value_usd, value_eur)
    values (v_uid, p_key, p_source, v_today, p_quantity, v_price, v_price * p_quantity, v_price * p_quantity * v_rate)
    on conflict (user_id, asset_symbol, source, snapshot_date) do update set
      amount = excluded.amount, value_usd = excluded.value_usd, value_eur = excluded.value_eur;
  else
    raise exception 'unknown kind %', p_kind;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.set_holding_quantity(text, text, numeric, text) from public, anon;
grant execute on function public.set_holding_quantity(text, text, numeric, text) to authenticated;
