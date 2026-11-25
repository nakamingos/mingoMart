-- Drop the legacy public.attributes table.
-- It is an exact duplicate of public.attributes_new (same 55,655 rows, all columns identical
-- as of 2026-11-25), nothing reads it, and the backfill scripts no longer write to it.
-- The only dependency is the redundant FK from ethscriptions_sepolia, which already has an
-- equivalent FK to attributes_new (ethscriptions_sepolia_sha_fkey1).

ALTER TABLE public.ethscriptions_sepolia DROP CONSTRAINT IF EXISTS ethscriptions_sepolia_sha_fkey;

DROP TABLE IF EXISTS public.attributes;
