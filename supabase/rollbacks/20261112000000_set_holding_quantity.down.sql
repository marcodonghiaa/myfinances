-- Removes set_holding_quantity. Snapshots it wrote stay: they are ordinary price rows.
drop function public.set_holding_quantity(text, text, numeric, text);
