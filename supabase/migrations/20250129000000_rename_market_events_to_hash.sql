-- Migration: Rename native market event strings to hash-native names
-- Description: Mingo Mart's active L1 market contract emits Hash* events.

UPDATE public.events
SET "type" = CASE "type"
  WHEN 'PhunkOffered' THEN 'HashOffered'
  WHEN 'PhunkBought' THEN 'HashBought'
  WHEN 'PhunkNoLongerForSale' THEN 'HashNoLongerForSale'
  ELSE "type"
END
WHERE "type" IN ('PhunkOffered', 'PhunkBought', 'PhunkNoLongerForSale');

UPDATE public.events_sepolia
SET "type" = CASE "type"
  WHEN 'PhunkOffered' THEN 'HashOffered'
  WHEN 'PhunkBought' THEN 'HashBought'
  WHEN 'PhunkNoLongerForSale' THEN 'HashNoLongerForSale'
  ELSE "type"
END
WHERE "type" IN ('PhunkOffered', 'PhunkBought', 'PhunkNoLongerForSale');

UPDATE public.events
SET "venue" = CASE "venue"
  WHEN 'etherphunks-market' THEN 'mingomart-market'
  WHEN 'etherphunks-auction' THEN 'mingomart-auction'
  ELSE "venue"
END
WHERE "venue" IN ('etherphunks-market', 'etherphunks-auction');

UPDATE public.events_sepolia
SET "venue" = CASE "venue"
  WHEN 'etherphunks-market' THEN 'mingomart-market'
  WHEN 'etherphunks-auction' THEN 'mingomart-auction'
  ELSE "venue"
END
WHERE "venue" IN ('etherphunks-market', 'etherphunks-auction');

CREATE OR REPLACE FUNCTION public.fetch_events(
    p_limit integer,
    p_type text DEFAULT NULL::text,
    p_collection_slug text DEFAULT 'ethereum-phunks'::text,
    p_offset integer DEFAULT 0
) RETURNS TABLE(
    "hashId" text,
    "from" text,
    "to" text,
    "tokenId" bigint,
    "blockTimestamp" timestamp with time zone,
    "type" text,
    "value" text,
    "venue" text,
    "slug" text,
    "sha" text
)
LANGUAGE plpgsql
AS $$
DECLARE
    "marketAddress" CONSTANT TEXT := '0xd3418772623be1a3cc6b6d45cb46420cedd9154a';
    "auctionAddress" CONSTANT TEXT := '';
BEGIN
    RETURN QUERY EXECUTE
    'SELECT
        e."hashId",
        e.from,
        e.to,
        eg."tokenId",
        e."blockTimestamp",
        e.type,
        e.value,
        e.venue,
        eg.slug,
        eg.sha
    FROM
        public.events e
    INNER JOIN public.ethscriptions eg ON e."hashId" = eg."hashId"
    WHERE
        eg.slug = ''' || p_collection_slug || '''
        AND e.to != ''' || "auctionAddress" || '''
        AND e.to != ''' || "marketAddress" || '''
        AND e.from != ''' || "auctionAddress" || '''
        AND e.type != ''HashNoLongerForSale''' ||
        (CASE WHEN p_type IS NOT NULL THEN
            ' AND e.type = ''' || p_type || ''''
        ELSE
            ''
        END) ||
    ' ORDER BY e."blockTimestamp" DESC, e."txId" ASC
    LIMIT ' || p_limit || '
    OFFSET ' || p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_events_sepolia(
    p_limit integer,
    p_type text DEFAULT NULL::text,
    p_collection_slug text DEFAULT 'ethereum-phunks'::text,
    p_offset integer DEFAULT 0
) RETURNS TABLE(
    "hashId" text,
    "from" text,
    "to" text,
    "tokenId" bigint,
    "blockTimestamp" timestamp with time zone,
    "type" text,
    "value" text,
    "venue" text,
    "slug" text,
    "sha" text
)
LANGUAGE plpgsql
AS $$
DECLARE
    "marketAddress" CONSTANT TEXT := '0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e';
    "auctionAddress" CONSTANT TEXT := '0xc6a824d8cce7c946a3f35879694b9261a36fc823';
BEGIN
    RETURN QUERY EXECUTE
    'SELECT
        e."hashId",
        e.from,
        e.to,
        eg."tokenId",
        e."blockTimestamp",
        e.type,
        e.value,
        e.venue,
        eg.slug,
        eg.sha
    FROM
        public.events_sepolia e
    INNER JOIN public.ethscriptions_sepolia eg ON e."hashId" = eg."hashId"
    WHERE
        eg.slug = ''' || p_collection_slug || '''
        AND e.to != ''' || "auctionAddress" || '''
        AND e.to != ''' || "marketAddress" || '''
        AND e.from != ''' || "auctionAddress" || '''
        AND e.type != ''HashNoLongerForSale''' ||
        (CASE WHEN p_type IS NOT NULL THEN
            ' AND e.type = ''' || p_type || ''''
        ELSE
            ''
        END) ||
    ' ORDER BY e."blockTimestamp" DESC, e."txId" ASC
    LIMIT ' || p_limit || '
    OFFSET ' || p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_user_events_sepolia(
    p_limit integer,
    p_address text,
    p_type text DEFAULT NULL::text,
    p_collection_slug text DEFAULT 'ethereum-phunks'::text
) RETURNS TABLE(
    "hashId" text,
    "from" text,
    "to" text,
    "tokenId" bigint,
    "blockTimestamp" timestamp with time zone,
    "type" text,
    "value" text,
    "venue" text,
    "slug" text,
    "sha" text
)
LANGUAGE plpgsql
AS $$
DECLARE
    "marketAddress" CONSTANT TEXT := '0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e';
BEGIN
    RETURN QUERY EXECUTE
    'WITH corrected_events AS (
        SELECT
            e."hashId",
            CASE
                WHEN e."from" = ''' || "marketAddress" || ''' AND e.type IN (''HashBought'', ''escrow'') THEN (
                    SELECT e2."from"
                    FROM public.events_sepolia e2
                    WHERE e2."to" = ''' || "marketAddress" || '''
                    AND e2."hashId" = e."hashId"
                    LIMIT 1
                )
                ELSE e."from"
            END AS "fromAddress",
            e."to" AS "toAddress",
            eg."tokenId",
            e."blockTimestamp",
            e.type,
            e.value,
            e.venue,
            eg.slug,
            eg.sha
        FROM
            public.events_sepolia e
        INNER JOIN public.ethscriptions_sepolia eg ON e."hashId" = eg."hashId"
        WHERE
            eg."slug" = ''' || p_collection_slug || '''
            AND (e."to" = ''' || p_address || ''' OR e."from" = ''' || p_address || ''' OR (
                e."from" = ''' || "marketAddress" || ''' AND e.type IN (''HashBought'', ''escrow'') AND (
                    SELECT e2."from"
                    FROM public.events_sepolia e2
                    WHERE e2."to" = ''' || "marketAddress" || '''
                    AND e2."hashId" = e."hashId"
                    LIMIT 1
                ) = ''' || p_address || '''
            ))
            AND e."to" != ''' || "marketAddress" || '''
            AND e.type != ''HashNoLongerForSale''' ||
            (CASE WHEN p_type IS NOT NULL THEN
                ' AND e.type = ''' || p_type || ''''
            ELSE
                ''
            END) ||
            ' AND NOT (e.type = ''transfer'' AND (e."to" = ''' || p_address || ''' OR e."from" = ''' || p_address || '''))'
    ' ORDER BY e."blockTimestamp" DESC
    LIMIT ' || p_limit
    || ') SELECT * FROM corrected_events;';
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_leaderboard()
RETURNS TABLE("address" text, "points" bigint, "sales" bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT u.address, u.points, COUNT(e.from) as sales
    FROM users u
    LEFT JOIN events e ON u.address = e.from AND e.type = 'HashBought'
    GROUP BY u.address
    ORDER BY u.points DESC
    LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_leaderboard_sepolia()
RETURNS TABLE("address" text, "points" bigint, "sales" bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT u.address, u.points, COUNT(e.from) as sales
    FROM users_sepolia u
    LEFT JOIN events_sepolia e ON u.address = e.from AND e.type = 'HashBought'
    GROUP BY u.address
    ORDER BY u.points DESC
    LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_top_sales(
    p_limit integer DEFAULT 100,
    p_slug text DEFAULT NULL::text
) RETURNS TABLE(
    "hashId" text,
    "tokenId" bigint,
    "value" numeric,
    "from" text,
    "to" text,
    "blockTimestamp" timestamp with time zone,
    "txHash" text,
    "slug" text,
    "type" text
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e."hashId",
        es."tokenId",
        e."value"::numeric / 1e18 as "value",
        e."from",
        e."to",
        e."blockTimestamp",
        e."txHash",
        es.slug,
        e.type
    FROM public.events e
    INNER JOIN public.ethscriptions es ON e."hashId" = es."hashId"
    WHERE
        (e.type = 'HashBought' OR (e.type = 'transfer' AND e."value"::numeric != 0))
        AND (p_slug IS NULL OR es.slug = p_slug)
    ORDER BY e."value"::numeric DESC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_volume(
    start_date timestamp with time zone DEFAULT (CURRENT_TIMESTAMP - '30 days'::interval),
    end_date timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    slug_filter text DEFAULT NULL::text
) RETURNS TABLE("volume" numeric, "sales" bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(e."value"::numeric / 1e18), 0) AS volume,
        COALESCE(COUNT(*), 0) AS sales
    FROM public.events e
    INNER JOIN public.ethscriptions es ON e."hashId" = es."hashId"
    WHERE
        (e.type = 'HashBought' OR (e.type = 'transfer' AND e."value"::numeric != 0))
        AND e."blockTimestamp" BETWEEN start_date AND end_date
        AND (slug_filter IS NULL OR es.slug = slug_filter);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_volume_sepolia(
    start_date timestamp with time zone DEFAULT (CURRENT_TIMESTAMP - '30 days'::interval),
    end_date timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    slug_filter text DEFAULT NULL::text
) RETURNS TABLE("volume" numeric, "sales" bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(e."value"::numeric / 1e18), 0) AS volume,
        COALESCE(COUNT(*), 0) AS sales
    FROM public.events_sepolia e
    INNER JOIN public.ethscriptions_sepolia es ON e."hashId" = es."hashId"
    WHERE
        e.type = 'HashBought'
        AND e."blockTimestamp" BETWEEN start_date AND end_date
        AND (slug_filter IS NULL OR es.slug = slug_filter);
END;
$$;

DROP INDEX IF EXISTS public.events_recent_activity_order_idx;
CREATE INDEX events_recent_activity_order_idx
ON public.events ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE
  type <> 'HashNoLongerForSale'
  AND "to" <> '0xd3418772623be1a3cc6b6d45cb46420cedd9154a'
  AND "to" <> ''
  AND "from" <> '';

DROP INDEX IF EXISTS public.events_sepolia_recent_activity_order_idx;
CREATE INDEX events_sepolia_recent_activity_order_idx
ON public.events_sepolia ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE
  type <> 'HashNoLongerForSale'
  AND "to" <> '0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e'
  AND "to" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823'
  AND "from" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823';
