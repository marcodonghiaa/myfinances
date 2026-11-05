-- Delete an investment or a crypto holding for good, with its price history and trades.
-- The snapshots reference the holding without "on delete cascade" and users can only read
-- them, so the app could only mark a holding sold. This removes a holding added by mistake,
-- and its value leaves past net worth too (that is built from the snapshots).
--
-- Security definer because users cannot delete snapshots themselves. Every statement is
-- pinned to auth.uid(), so a caller only ever touches their own rows.
-- p_kind 'stock': p_key is the ISIN. p_kind 'crypto': p_key is the coin symbol, p_source its
-- source. Crypto trades are per coin, so they go only when no other source holds that coin.
-- Returns the number of holdings deleted (0 when there was nothing to delete).
create function public.delete_holding(p_kind text, p_key text, p_source text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  if p_kind = 'stock' then
    delete from portfolio_snapshots where user_id = v_uid and isin = p_key;
    delete from portfolio_holdings where user_id = v_uid and isin = p_key;
    get diagnostics v_count = row_count;
    delete from holding_trades where user_id = v_uid and kind = 'stock' and key = p_key;
  elsif p_kind = 'crypto' then
    if p_source is null then
      raise exception 'crypto needs a source';
    end if;
    delete from crypto_snapshots
      where user_id = v_uid and asset_symbol = p_key and source = p_source;
    delete from crypto_holdings
      where user_id = v_uid and asset_symbol = p_key and source = p_source;
    get diagnostics v_count = row_count;
    if not exists (select 1 from crypto_holdings where user_id = v_uid and asset_symbol = p_key) then
      delete from holding_trades where user_id = v_uid and kind = 'crypto' and key = p_key;
    end if;
  else
    raise exception 'unknown kind %', p_kind;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.delete_holding(text, text, text) from public, anon;
grant execute on function public.delete_holding(text, text, text) to authenticated;
