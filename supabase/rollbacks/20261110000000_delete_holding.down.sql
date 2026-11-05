-- Removes delete_holding. Holdings already deleted with it stay deleted.
drop function public.delete_holding(text, text, text);
