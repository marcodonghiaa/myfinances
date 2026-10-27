-- The data repair is intentionally not undone: the old currency/hash values were wrong.
drop index if exists public.accounts_user_identification_hash_key;
