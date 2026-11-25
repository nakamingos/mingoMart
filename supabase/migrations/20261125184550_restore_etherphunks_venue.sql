-- Restore the EtherPhunks venue on historical market events.
-- Migration 20260523225559 relabelled 'etherphunks-market' events as 'mingomart-market', which
-- made EtherPhunks sales and listings look like they happened on the Mingo Mart contract. The
-- Mingo Mart market had not been deployed when these were indexed, so every existing
-- 'mingomart-market' row is EtherPhunks history. The timestamp cutoff keeps this from
-- relabelling genuine Mingo Mart events if the migration runs after the contract launches.

UPDATE public.events
SET "venue" = 'etherphunks-market'
WHERE "venue" = 'mingomart-market'
  AND "blockTimestamp" < '2026-11-26';
