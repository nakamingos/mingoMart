-- Migration: Add venue provenance to event history
-- Description: Stores where/how an event was produced without changing event type names.

ALTER TABLE public.events
ADD COLUMN IF NOT EXISTS "venue" text;

ALTER TABLE public.events_sepolia
ADD COLUMN IF NOT EXISTS "venue" text;

COMMENT ON COLUMN public.events."venue" IS
'Stable venue identifier describing where/how the event was produced.';

COMMENT ON COLUMN public.events_sepolia."venue" IS
'Stable venue identifier describing where/how the event was produced.';

DROP FUNCTION IF EXISTS public.fetch_events(integer, text, text, integer);

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
        AND e.type != ''PhunkNoLongerForSale''' ||
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

ALTER FUNCTION public.fetch_events(integer, text, text, integer) OWNER TO postgres;

GRANT ALL ON FUNCTION public.fetch_events(integer, text, text, integer) TO anon;
GRANT ALL ON FUNCTION public.fetch_events(integer, text, text, integer) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_events(integer, text, text, integer) TO service_role;

DROP FUNCTION IF EXISTS public.fetch_events_sepolia(integer, text, text, integer);

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
        AND e.type != ''PhunkNoLongerForSale''' ||
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

ALTER FUNCTION public.fetch_events_sepolia(integer, text, text, integer) OWNER TO postgres;

GRANT ALL ON FUNCTION public.fetch_events_sepolia(integer, text, text, integer) TO anon;
GRANT ALL ON FUNCTION public.fetch_events_sepolia(integer, text, text, integer) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_events_sepolia(integer, text, text, integer) TO service_role;

DROP FUNCTION IF EXISTS public.fetch_user_events_sepolia(integer, text, text, text);

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
                WHEN e."from" = ''' || "marketAddress" || ''' AND e.type IN (''PhunkBought'', ''escrow'') THEN (
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
                e."from" = ''' || "marketAddress" || ''' AND e.type IN (''PhunkBought'', ''escrow'') AND (
                    SELECT e2."from"
                    FROM public.events_sepolia e2
                    WHERE e2."to" = ''' || "marketAddress" || '''
                    AND e2."hashId" = e."hashId"
                    LIMIT 1
                ) = ''' || p_address || '''
            ))
            AND e."to" != ''' || "marketAddress" || '''
            AND e.type != ''PhunkNoLongerForSale''' ||
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

ALTER FUNCTION public.fetch_user_events_sepolia(integer, text, text, text) OWNER TO postgres;

GRANT ALL ON FUNCTION public.fetch_user_events_sepolia(integer, text, text, text) TO anon;
GRANT ALL ON FUNCTION public.fetch_user_events_sepolia(integer, text, text, text) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_user_events_sepolia(integer, text, text, text) TO service_role;
