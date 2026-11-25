-- Clear the stored Emblem Vault metadata blobs on wrapped ethscriptions.
-- Each row held the full Emblem Vault API response (~4 KB of JSON, ~14 MB in total). Nothing
-- reads it: the indexer extracts the fields it needs (vault address, owner, status, token id)
-- into their own columns, and the full record can be re-fetched from "metadataUrl". The indexer
-- no longer stores it for new rows.

UPDATE public.wrapped_ethscriptions SET "metadata" = NULL WHERE "metadata" IS NOT NULL;
UPDATE public.wrapped_ethscriptions_sepolia SET "metadata" = NULL WHERE "metadata" IS NOT NULL;
