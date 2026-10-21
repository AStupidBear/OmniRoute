-- Migration 207 originally removed OpenCode Free upstream. The private
-- personal/omniroute-private-fixes branch restores that provider, so retain
-- its local connections and model configuration. Keep this migration number
-- as a no-op so the database migration history remains aligned with upstream.
SELECT 1;
