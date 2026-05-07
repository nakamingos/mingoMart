-- Migration: Add wrapped ethscription state
-- Description: Tracks external wrapper/vault ownership separately from native ethscription ownership.

CREATE TABLE IF NOT EXISTS public.wrapped_ethscriptions (
  "hashId" text NOT NULL REFERENCES public.ethscriptions("hashId") ON DELETE CASCADE,
  "wrapperVenue" text NOT NULL,
  "wrapperContract" text NOT NULL,
  "wrapperTokenId" text NOT NULL,
  "vaultAddress" text,
  "wrappedOwner" text,
  "active" boolean NOT NULL DEFAULT true,
  "status" text,
  "metadataUrl" text,
  "metadata" jsonb,
  "wrappedAtBlock" bigint,
  "unwrappedAtBlock" bigint,
  "wrappedTxHash" text,
  "unwrappedTxHash" text,
  "lastMetadataSyncAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("wrapperVenue", "wrapperContract", "wrapperTokenId")
);

COMMENT ON TABLE public.wrapped_ethscriptions IS
'External wrapper/vault state for native ethscriptions. Does not replace ethscriptions.owner/prevOwner.';

COMMENT ON COLUMN public.wrapped_ethscriptions."wrappedOwner" IS
'Current beneficial owner of the wrapper NFT or vault token.';

CREATE INDEX IF NOT EXISTS wrapped_ethscriptions_hash_id_idx
ON public.wrapped_ethscriptions ("hashId");

CREATE INDEX IF NOT EXISTS wrapped_ethscriptions_active_hash_id_idx
ON public.wrapped_ethscriptions ("hashId", "wrapperVenue")
WHERE "active" = true;

CREATE UNIQUE INDEX IF NOT EXISTS wrapped_ethscriptions_one_active_per_venue_idx
ON public.wrapped_ethscriptions ("hashId", "wrapperVenue")
WHERE "active" = true;

ALTER TABLE public.wrapped_ethscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.wrapped_ethscriptions;
CREATE POLICY "Enable read access for all users" ON public.wrapped_ethscriptions
FOR SELECT USING (true);

GRANT ALL ON TABLE public.wrapped_ethscriptions TO anon;
GRANT ALL ON TABLE public.wrapped_ethscriptions TO authenticated;
GRANT ALL ON TABLE public.wrapped_ethscriptions TO service_role;

CREATE TABLE IF NOT EXISTS public.wrapped_ethscriptions_sepolia (
  "hashId" text NOT NULL REFERENCES public.ethscriptions_sepolia("hashId") ON DELETE CASCADE,
  "wrapperVenue" text NOT NULL,
  "wrapperContract" text NOT NULL,
  "wrapperTokenId" text NOT NULL,
  "vaultAddress" text,
  "wrappedOwner" text,
  "active" boolean NOT NULL DEFAULT true,
  "status" text,
  "metadataUrl" text,
  "metadata" jsonb,
  "wrappedAtBlock" bigint,
  "unwrappedAtBlock" bigint,
  "wrappedTxHash" text,
  "unwrappedTxHash" text,
  "lastMetadataSyncAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("wrapperVenue", "wrapperContract", "wrapperTokenId")
);

COMMENT ON TABLE public.wrapped_ethscriptions_sepolia IS
'Sepolia mirror of wrapped_ethscriptions.';

CREATE INDEX IF NOT EXISTS wrapped_ethscriptions_sepolia_hash_id_idx
ON public.wrapped_ethscriptions_sepolia ("hashId");

CREATE INDEX IF NOT EXISTS wrapped_ethscriptions_sepolia_active_hash_id_idx
ON public.wrapped_ethscriptions_sepolia ("hashId", "wrapperVenue")
WHERE "active" = true;

CREATE UNIQUE INDEX IF NOT EXISTS wrapped_ethscriptions_sepolia_one_active_per_venue_idx
ON public.wrapped_ethscriptions_sepolia ("hashId", "wrapperVenue")
WHERE "active" = true;

ALTER TABLE public.wrapped_ethscriptions_sepolia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.wrapped_ethscriptions_sepolia;
CREATE POLICY "Enable read access for all users" ON public.wrapped_ethscriptions_sepolia
FOR SELECT USING (true);

GRANT ALL ON TABLE public.wrapped_ethscriptions_sepolia TO anon;
GRANT ALL ON TABLE public.wrapped_ethscriptions_sepolia TO authenticated;
GRANT ALL ON TABLE public.wrapped_ethscriptions_sepolia TO service_role;
