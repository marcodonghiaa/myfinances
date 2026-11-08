-- Subscription radar: detect recurring streams every 6 h, 10 minutes after post-sync (UTC).
-- Needs the Edge Function detect-recurring deployed (verify_jwt = false) and call_edge_function
-- from 20261118000000_schedule_sync.sql. cron.schedule replaces a job of the same name.
select cron.schedule('detect-recurring', '47 */6 * * *', $$select public.call_edge_function('detect-recurring')$$);
