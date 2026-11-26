-- What the original recipient paid to mint an item, for collections minted through a paid contract
-- and inscribed by a backend service (populated per collection by indexer/scripts/import-mint-costs.ts).
--   "mintCost": wei paid per item; NULL = unknown, 0 = free
--   "mintKind": 'paid' | 'free' (promo, team share, free claims) | 'airdrop' (e.g. Art Drop replacements)
-- Used by sale notifications to show the seller's P&L when they were the original minter.

ALTER TABLE public.ethscriptions
  ADD COLUMN IF NOT EXISTS "mintCost" numeric,
  ADD COLUMN IF NOT EXISTS "mintKind" text CHECK ("mintKind" IN ('paid', 'free', 'airdrop'));

ALTER TABLE public.ethscriptions_sepolia
  ADD COLUMN IF NOT EXISTS "mintCost" numeric,
  ADD COLUMN IF NOT EXISTS "mintKind" text CHECK ("mintKind" IN ('paid', 'free', 'airdrop'));
