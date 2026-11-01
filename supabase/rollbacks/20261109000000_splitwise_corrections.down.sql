-- Removes apply_splitwise_corrections. Corrections already applied stay: they are ordinary rows.
drop function public.apply_splitwise_corrections(uuid, text, jsonb, jsonb, jsonb);
