#!/bin/bash
# Race check for add_manual_transaction (local only, needs a throwaway DB with all migrations).
# Two sessions add the first rows of a new source at the same time; there must be ONE account.
#   PSQL="psql -U postgres -d <throwaway db>" supabase/rehearsals/manual_transaction_race.sh
set -euo pipefail
PSQL=${PSQL:?set PSQL to a psql command for a throwaway database}
U=00000000-0000-0000-0000-0000000000e1
$PSQL -q -c "insert into auth.users (id, email) values ('$U', 'e1@example.test') on conflict do nothing;
  delete from transactions where user_id = '$U'; delete from accounts where user_id = '$U';"
call="select set_config('request.jwt.claim.sub', '$U', false);
  begin; select public.add_manual_transaction('2026-03-01', 'Row', 1, 'DBIT', 'EUR', null, 'Race Bank');
  select pg_sleep(1); commit;"
$PSQL -q -c "$call" >/dev/null & a=$!
sleep 0.3
$PSQL -q -c "$call" >/dev/null & b=$!
wait $a $b
n=$($PSQL -tA -c "select count(*) from accounts where user_id = '$U' and label = 'Race Bank'")
$PSQL -q -c "delete from transactions where user_id = '$U'; delete from accounts where user_id = '$U'; delete from auth.users where id = '$U';"
if [ "$n" != "1" ]; then echo "FAIL: $n accounts for one new source"; exit 1; fi
echo "OK: one account"
