-- Drop indexes and unique constraints that exactly duplicate another index on the same table
-- (usually the primary key). Uniqueness and lookup performance are unchanged.
--
-- Postgres won't drop ethscriptions(_sepolia)_hashId_key while foreign keys depend on it, so
-- those 12 FKs are dropped and re-created with identical names and definitions (copied from
-- production via pg_get_constraintdef on 2026-11-25); they then attach to the primary keys.

-- 1. Foreign keys that depend on the duplicate hashId unique constraints
ALTER TABLE public."auctions" DROP CONSTRAINT "auctions_hashId_fkey";
ALTER TABLE public."auctions_sepolia" DROP CONSTRAINT "public_auctions_sepolia_hashId_fkey";
ALTER TABLE public."bids" DROP CONSTRAINT "bids_hashId_fkey";
ALTER TABLE public."bids_sepolia" DROP CONSTRAINT "public_bids_sepolia_hashId_fkey";
ALTER TABLE public."events" DROP CONSTRAINT "events_hashId_fkey";
ALTER TABLE public."events_sepolia" DROP CONSTRAINT "public_events_sepolia_hashId_fkey";
ALTER TABLE public."listings" DROP CONSTRAINT "listings_hashId_fkey";
ALTER TABLE public."listings_sepolia" DROP CONSTRAINT "public_listings_sepolia_hashId_fkey";
ALTER TABLE public."nfts" DROP CONSTRAINT "nfts_hashId_fkey";
ALTER TABLE public."nfts_sepolia" DROP CONSTRAINT "nfts_sepolia_hashId_fkey";
ALTER TABLE public."wrapped_ethscriptions" DROP CONSTRAINT "wrapped_ethscriptions_hashId_fkey";
ALTER TABLE public."wrapped_ethscriptions_sepolia" DROP CONSTRAINT "wrapped_ethscriptions_sepolia_hashId_fkey";

-- 2. Duplicate unique constraints (each duplicates the table's primary key)
ALTER TABLE public."events" DROP CONSTRAINT "events_txId_key";
ALTER TABLE public."attributes_new" DROP CONSTRAINT "attributes_new_sha_key";
ALTER TABLE public."ethscriptions" DROP CONSTRAINT "ethscriptions_hashId_key";
ALTER TABLE public."events_sepolia" DROP CONSTRAINT "events_sepolia_txId_key";
ALTER TABLE public."ethscriptions_sepolia" DROP CONSTRAINT "ethscriptions_sepolia_hashId_key";
ALTER TABLE public."comments" DROP CONSTRAINT "comments_id_key";
ALTER TABLE public."comments_sepolia" DROP CONSTRAINT "comments_sepolia_id_key";
ALTER TABLE public."connected_accounts" DROP CONSTRAINT "connected_accounts_id_key";
ALTER TABLE public."_global_config" DROP CONSTRAINT "admin_network_key";

-- 3. Duplicate plain indexes
DROP INDEX public."ethscriptions_hashId_idx";
DROP INDEX public."ethscriptions_sepolia_hashId_idx";
DROP INDEX public."idx_refresh_tokens_token_hash";
DROP INDEX public."wrapped_ethscriptions_active_hash_id_idx";
DROP INDEX public."wrapped_ethscriptions_sepolia_active_hash_id_idx";

-- 4. Re-create the foreign keys (they now use the primary key indexes)
ALTER TABLE public."auctions" ADD CONSTRAINT "auctions_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId");
ALTER TABLE public."auctions_sepolia" ADD CONSTRAINT "public_auctions_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId");
ALTER TABLE public."bids" ADD CONSTRAINT "bids_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId");
ALTER TABLE public."bids_sepolia" ADD CONSTRAINT "public_bids_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions_sepolia("hashId");
ALTER TABLE public."events" ADD CONSTRAINT "events_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId") ON UPDATE RESTRICT ON DELETE CASCADE;
ALTER TABLE public."events_sepolia" ADD CONSTRAINT "public_events_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions_sepolia("hashId");
ALTER TABLE public."listings" ADD CONSTRAINT "listings_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId");
ALTER TABLE public."listings_sepolia" ADD CONSTRAINT "public_listings_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions_sepolia("hashId");
ALTER TABLE public."nfts" ADD CONSTRAINT "nfts_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId");
ALTER TABLE public."nfts_sepolia" ADD CONSTRAINT "nfts_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions_sepolia("hashId");
ALTER TABLE public."wrapped_ethscriptions" ADD CONSTRAINT "wrapped_ethscriptions_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions("hashId") ON DELETE CASCADE;
ALTER TABLE public."wrapped_ethscriptions_sepolia" ADD CONSTRAINT "wrapped_ethscriptions_sepolia_hashId_fkey" FOREIGN KEY ("hashId") REFERENCES public.ethscriptions_sepolia("hashId") ON DELETE CASCADE;
