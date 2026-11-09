-- No-op on purpose. 20261121000000 only changes data: it deletes detector-only rows (the detector recreates
-- them), drops the currency from stream_key, merges rows that then collide, confirms dismissed override rows
-- that a kept override maps to, and fills typical_amount_eur. None of that can be undone exactly, and the
-- old detector would simply write old-shape keys again beside the new ones. Restore from a backup if needed.
select 1;
