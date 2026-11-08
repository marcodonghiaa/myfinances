select cron.unschedule('detect-recurring') where exists (select 1 from cron.job where jobname = 'detect-recurring');
