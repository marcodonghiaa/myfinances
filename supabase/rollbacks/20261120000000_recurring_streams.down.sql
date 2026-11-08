-- Removes recurring_streams and its RPCs. Run after reverting the detector and the frontend.
drop function public.stream_action(uuid, text, jsonb);
drop function public.upsert_detected_streams(uuid, jsonb);
drop table public.recurring_streams;
