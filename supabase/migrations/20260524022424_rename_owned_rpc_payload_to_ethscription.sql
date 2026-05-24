-- Rename the owned-items RPC payload key from "phunk" to "ethscription".

CREATE OR REPLACE FUNCTION "public"."fetch_ethscriptions_owned_with_listings_and_bids"("address" "text", "collection_slug" "text" DEFAULT 'ethereum-phunks'::"text") RETURNS TABLE("ethscription" "json")
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    "marketAddress" CONSTANT TEXT := '0xd3418772623be1a3cc6b6d45cb46420cedd9154a';
BEGIN
    RETURN QUERY
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'owner', p.owner,
            'prevOwner', p."prevOwner",
            'slug', p.slug,
            'sha', p.sha
        )),
        'listing', json_agg(json_strip_nulls(json_build_object(
            'createdAt', l."createdAt",
            'minValue', l."minValue"
        ))) FILTER (WHERE l."hashId" IS NOT NULL)
    )
    FROM public.ethscriptions p
    LEFT JOIN public.listings l ON p."hashId" = l."hashId" AND l."toAddress" = '0x0000000000000000000000000000000000000000'
    LEFT JOIN public.bids b ON p."hashId" = b."hashId"
    WHERE (p.owner = address OR (p.owner = "marketAddress" AND p."prevOwner" = address))
          AND p."slug" = collection_slug
    GROUP BY p."hashId", p."tokenId", p.owner, p."prevOwner", p.slug, p.sha;
END;
$$;

DROP INDEX IF EXISTS public.events_recent_activity_order_idx;
CREATE INDEX IF NOT EXISTS events_recent_activity_order_idx
ON public.events ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE
  type <> 'HashNoLongerForSale'
  AND "to" <> '0xd3418772623be1a3cc6b6d45cb46420cedd9154a'
  AND "to" <> ''
  AND "from" <> '';

DROP INDEX IF EXISTS public.events_sepolia_recent_activity_order_idx;
CREATE INDEX IF NOT EXISTS events_sepolia_recent_activity_order_idx
ON public.events_sepolia ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE
  type <> 'HashNoLongerForSale'
  AND "to" <> '0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e'
  AND "to" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823'
  AND "from" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823';

CREATE OR REPLACE FUNCTION "public"."fetch_ethscriptions_owned_with_listings_and_bids_sepolia"("address" "text", "collection_slug" "text" DEFAULT 'ethereum-phunks'::"text") RETURNS TABLE("ethscription" "json")
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    "marketAddress" CONSTANT TEXT := '0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e';
    "bridgeAddressMainnet" CONSTANT TEXT := '0x1565f60d2469f18bbcc96b2c29220412f2fe98bd';
BEGIN
    RETURN QUERY
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'owner', p.owner,
            'prevOwner', p."prevOwner",
            'slug', p.slug,
            'sha', p.sha
        )),
        'listing', json_agg(json_strip_nulls(json_build_object(
            'createdAt', l."createdAt",
            'minValue', l."minValue"
        ))) FILTER (WHERE l."hashId" IS NOT NULL)
    )
    FROM public.ethscriptions_sepolia p
    LEFT JOIN public.listings_sepolia l ON p."hashId" = l."hashId" AND l."toAddress" = '0x0000000000000000000000000000000000000000'
    LEFT JOIN public.bids_sepolia b ON p."hashId" = b."hashId"
    WHERE (
      p.owner = address
      OR (
        p.owner = "marketAddress"
        AND p."prevOwner" = address
      )
      OR (
        p.owner = "bridgeAddressMainnet"
        AND p."prevOwner" = address
      )
    )
    AND p."slug" = collection_slug
    GROUP BY p."hashId", p."tokenId", p.owner, p."prevOwner", p.slug, p.sha;
END;
$$;
