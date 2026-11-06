-- Removes the bank sync fan-out. pg_net stays: dropping it would also drop net._http_response.
drop function if exists public.sync_all_banks();
