-- Stops the Supabase schedule (restart the other scheduler after this, or nothing syncs).
-- pg_cron stays installed; its run history stays in cron.job_run_details.
select cron.unschedule(jobname) from cron.job
 where jobname in ('sync-banks', 'post-sync', 'sync-prices', 'notify-worth-it', 'notify-consent');
drop function if exists public.call_edge_function(text, jsonb);
