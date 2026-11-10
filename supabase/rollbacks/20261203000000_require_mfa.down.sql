-- Stops the database from requiring the authenticator code. Run after reverting the Edge Functions
-- (they call mfa_satisfied). Enrolled authenticators stay in auth.mfa_factors.
alter role authenticator reset pgrst.db_pre_request;
notify pgrst, 'reload config';
drop function if exists public.require_mfa();
drop function if exists public.mfa_satisfied();
