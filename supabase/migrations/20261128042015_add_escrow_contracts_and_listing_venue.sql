-- Treat every escrow market the same way, instead of special-casing the EtherPhunks contract.
--
-- 1. escrow_contracts(_sepolia): the escrow contracts we recognize, one row per contract. Mingo
--    Mart's own market is added when it is deployed. Never add the zero address: transfers to it
--    are burns, and listing it would hide them from activity.
-- 2. listings(_sepolia).venue: which market a listing belongs to, and part of the primary key, so
--    one venue's events can never overwrite or remove another venue's listing. The existing
--    mainnet rows are all EtherPhunks listings. Mingo Mart's for-sale views only read
--    'mingomart-market' rows.
-- 3. Activity: hide transfers INTO any escrow contract (the deposit half of listing). Transfers
--    out are kept. The recent-activity index no longer names any address, so adding a venue
--    never needs a rebuild.
-- 4. Owned items and the chat holder check: an item held by an escrow contract belongs to whoever
--    deposited it (prevOwner). Owned items also say which venue holds it.
-- fetch_events(_sepolia) used to build its SQL by pasting caller input into a string; they are
-- now plain parameterized queries.

------------------------------------------------------------------------------------------------
-- 1. Escrow contracts
------------------------------------------------------------------------------------------------

CREATE TABLE public.escrow_contracts (
    address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
    venue text NOT NULL CHECK (venue <> '')
);

CREATE TABLE public.escrow_contracts_sepolia (
    address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
    venue text NOT NULL CHECK (venue <> '')
);

COMMENT ON TABLE public.escrow_contracts IS
  'Escrow contracts of the markets we recognize. An item held by one belongs to its prevOwner; transfers into one are hidden from activity. Mingo Mart''s market is added at deploy. Never add the zero address.';
COMMENT ON TABLE public.escrow_contracts_sepolia IS
  'Sepolia/local copy of escrow_contracts.';

INSERT INTO public.escrow_contracts (address, venue) VALUES
  ('0xd3418772623be1a3cc6b6d45cb46420cedd9154a', 'etherphunks-market'),
  ('0x57b8792c775d34aa96092400983c3e112fcbc296', 'etch-market'),
  ('0xd729a94d6366a4feac4a6869c8b3573cee4701a9', 'ethscriptions-market'),
  -- Ordex escrows through the ethscriptions transfer proxy.
  ('0xc33f8610941be56fb0d84e25894c0d928cc97dde', 'ordex-market');

-- The old Sepolia test market.
INSERT INTO public.escrow_contracts_sepolia (address, venue) VALUES
  ('0x3dfbc8c62d3ce0059bdaf21787ec24d5d116fe1e', 'etherphunks-market');

ALTER TABLE public.escrow_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_contracts_sepolia ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users" ON public.escrow_contracts FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON public.escrow_contracts_sepolia FOR SELECT USING (true);
REVOKE ALL ON TABLE public.escrow_contracts, public.escrow_contracts_sepolia FROM anon, authenticated;
GRANT SELECT ON TABLE public.escrow_contracts, public.escrow_contracts_sepolia TO anon, authenticated;
GRANT ALL ON TABLE public.escrow_contracts, public.escrow_contracts_sepolia TO service_role;

------------------------------------------------------------------------------------------------
-- 2. Listing venue
------------------------------------------------------------------------------------------------

-- No lasting default: every writer has to say which venue a listing belongs to.
ALTER TABLE public.listings ADD COLUMN venue text NOT NULL DEFAULT 'etherphunks-market' CHECK (venue <> '');
ALTER TABLE public.listings ALTER COLUMN venue DROP DEFAULT;
ALTER TABLE public.listings DROP CONSTRAINT listings_pkey;
ALTER TABLE public.listings ADD CONSTRAINT listings_pkey PRIMARY KEY ("hashId", venue);

ALTER TABLE public.listings_sepolia ADD COLUMN venue text NOT NULL DEFAULT 'etherphunks-market' CHECK (venue <> '');
ALTER TABLE public.listings_sepolia ALTER COLUMN venue DROP DEFAULT;
ALTER TABLE public.listings_sepolia DROP CONSTRAINT listings_sepolia_pkey;
ALTER TABLE public.listings_sepolia ADD CONSTRAINT listings_sepolia_pkey PRIMARY KEY ("hashId", venue);

-- For-sale views: Mingo Mart listings only.

CREATE OR REPLACE FUNCTION public.fetch_ethscriptions_with_listings_and_bids(collection_slug text DEFAULT 'ethereum-phunks'::text)
 RETURNS TABLE(ethscription json)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'slug', p."slug",
            'sha', p.sha,
            'owner', p.owner,
            'prevOwner', p."prevOwner"
        )),
        'listing', json_agg(json_strip_nulls(json_build_object(
            'createdAt', l."createdAt",
            'minValue', l."minValue",
            'listedBy', l."listedBy"
        ))) FILTER (WHERE l."hashId" IS NOT NULL),
        'bid', json_agg(json_strip_nulls(json_build_object(
            'createdAt', b."createdAt",
            'value', b.value,
            'fromAddress', b."fromAddress"
        ))) FILTER (WHERE b."hashId" IS NOT NULL),
        'auction', json_agg(json_strip_nulls(json_build_object(
            'auctionId', a."auctionId",
            'createdAt', a."createdAt",
            'prevOwner', a."prevOwner",
            'amount', a.amount,
            'startTime', a."startTime",
            'endTime', a."endTime",
            'bidder', a.bidder,
            'settled', a.settled
        ))) FILTER (WHERE a."hashId" IS NOT NULL)
    )
    FROM public.ethscriptions p
    LEFT JOIN public.listings l ON p."hashId" = l."hashId" AND l."toAddress" = '0x0000000000000000000000000000000000000000' AND l.venue = 'mingomart-market'
    LEFT JOIN public.bids b ON p."hashId" = b."hashId"
    LEFT JOIN public.auctions a ON p."hashId" = a."hashId" AND a."settled" = false
    WHERE
        p."slug" = collection_slug
        AND (EXISTS (SELECT 1 FROM public.listings l2 WHERE l2."hashId" = p."hashId" AND l2."toAddress" = '0x0000000000000000000000000000000000000000' AND l2.venue = 'mingomart-market')
             OR EXISTS (SELECT 1 FROM public.bids b2 WHERE b2."hashId" = p."hashId")
             OR EXISTS (SELECT 1 FROM public.auctions a2 WHERE a2."hashId" = p."hashId" AND a2."settled" = false))
    GROUP BY p."hashId";
END;
$function$;

CREATE OR REPLACE FUNCTION public.fetch_ethscriptions_with_listings_and_bids_sepolia(collection_slug text DEFAULT 'ethereum-phunks'::text)
 RETURNS TABLE(ethscription json)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'slug', p."slug",
            'sha', p.sha,
            'owner', p.owner,
            'prevOwner', p."prevOwner"
        )),
        'listing', json_agg(json_strip_nulls(json_build_object(
            'createdAt', l."createdAt",
            'minValue', l."minValue",
            'listedBy', l."listedBy"
        ))) FILTER (WHERE l."hashId" IS NOT NULL),
        'bid', json_agg(json_strip_nulls(json_build_object(
            'createdAt', b."createdAt",
            'value', b.value,
            'fromAddress', b."fromAddress"
        ))) FILTER (WHERE b."hashId" IS NOT NULL),
        'auction', json_agg(json_strip_nulls(json_build_object(
            'auctionId', a."auctionId",
            'createdAt', a."createdAt",
            'prevOwner', a."prevOwner",
            'amount', a.amount,
            'startTime', a."startTime",
            'endTime', a."endTime",
            'bidder', a.bidder,
            'settled', a.settled
        ))) FILTER (WHERE a."hashId" IS NOT NULL)
    )
    FROM public.ethscriptions_sepolia p
    LEFT JOIN public.listings_sepolia l ON p."hashId" = l."hashId" AND l."toAddress" = '0x0000000000000000000000000000000000000000' AND l.venue = 'mingomart-market'
    LEFT JOIN public.bids_sepolia b ON p."hashId" = b."hashId"
    LEFT JOIN public.auctions_sepolia a ON p."hashId" = a."hashId" AND a."settled" = false
    WHERE
        p."slug" = collection_slug
        AND (EXISTS (SELECT 1 FROM public.listings_sepolia l2 WHERE l2."hashId" = p."hashId" AND l2."toAddress" = '0x0000000000000000000000000000000000000000' AND l2.venue = 'mingomart-market')
             OR EXISTS (SELECT 1 FROM public.bids_sepolia b2 WHERE b2."hashId" = p."hashId")
             OR EXISTS (SELECT 1 FROM public.auctions_sepolia a2 WHERE a2."hashId" = p."hashId" AND a2."settled" = false))
    GROUP BY p."hashId";
END;
$function$;

------------------------------------------------------------------------------------------------
-- 3. Activity
------------------------------------------------------------------------------------------------

DROP INDEX IF EXISTS public.events_recent_activity_order_idx;
CREATE INDEX events_recent_activity_order_idx
ON public.events ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE type <> 'HashNoLongerForSale' AND "to" <> '' AND "from" <> '';

DROP INDEX IF EXISTS public.events_sepolia_recent_activity_order_idx;
CREATE INDEX events_sepolia_recent_activity_order_idx
ON public.events_sepolia ("blockTimestamp" DESC, "txId", "hashId")
INCLUDE ("from", "to", type, value, venue)
WHERE type <> 'HashNoLongerForSale' AND "to" <> '' AND "from" <> '';

-- The first three conditions repeat the index predicate so the planner can use it.
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
LANGUAGE sql
STABLE
AS $function$
    SELECT
        e."hashId",
        e."from",
        e."to",
        eg."tokenId",
        e."blockTimestamp",
        e.type,
        e.value,
        e.venue,
        eg.slug,
        eg.sha
    FROM public.events e
    INNER JOIN public.ethscriptions eg ON e."hashId" = eg."hashId"
    WHERE e.type <> 'HashNoLongerForSale'
      AND e."to" <> ''
      AND e."from" <> ''
      AND eg.slug = p_collection_slug
      AND (p_type IS NULL OR e.type = p_type)
      AND NOT EXISTS (SELECT 1 FROM public.escrow_contracts c WHERE c.address = e."to")
    ORDER BY e."blockTimestamp" DESC, e."txId" ASC
    LIMIT p_limit
    OFFSET p_offset;
$function$;

-- Sepolia also hides the old test auction house, in both directions, as before.
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
LANGUAGE sql
STABLE
AS $function$
    SELECT
        e."hashId",
        e."from",
        e."to",
        eg."tokenId",
        e."blockTimestamp",
        e.type,
        e.value,
        e.venue,
        eg.slug,
        eg.sha
    FROM public.events_sepolia e
    INNER JOIN public.ethscriptions_sepolia eg ON e."hashId" = eg."hashId"
    WHERE e.type <> 'HashNoLongerForSale'
      AND e."to" <> ''
      AND e."from" <> ''
      AND eg.slug = p_collection_slug
      AND (p_type IS NULL OR e.type = p_type)
      AND e."to" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823'
      AND e."from" <> '0xc6a824d8cce7c946a3f35879694b9261a36fc823'
      AND NOT EXISTS (SELECT 1 FROM public.escrow_contracts_sepolia c WHERE c.address = e."to")
    ORDER BY e."blockTimestamp" DESC, e."txId" ASC
    LIMIT p_limit
    OFFSET p_offset;
$function$;

------------------------------------------------------------------------------------------------
-- 4. Owned items and holders
------------------------------------------------------------------------------------------------

-- 'escrow' is set when an escrow contract holds the item; 'listing' is that venue's public
-- listing by the depositor, if any. The parameter is written with the function name because
-- escrow_contracts also has an "address" column, which would otherwise win.
CREATE OR REPLACE FUNCTION public.fetch_ethscriptions_owned_with_listings_and_bids(address text, collection_slug text DEFAULT 'ethereum-phunks'::text)
 RETURNS TABLE(ethscription json)
 LANGUAGE sql
 STABLE
AS $function$
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'owner', p.owner,
            'prevOwner', p."prevOwner",
            'slug', p.slug,
            'sha', p.sha
        )),
        'escrow', CASE WHEN c.address IS NOT NULL THEN json_build_object('venue', c.venue, 'address', c.address) END,
        'listing', (
            SELECT json_agg(json_strip_nulls(json_build_object(
                'createdAt', l."createdAt",
                'minValue', l."minValue",
                'venue', l.venue
            )))
            FROM public.listings l
            WHERE l."hashId" = p."hashId"
              AND l."toAddress" = '0x0000000000000000000000000000000000000000'
              AND l.venue = c.venue
              AND l."listedBy" = p."prevOwner"
        )
    )
    FROM public.ethscriptions p
    LEFT JOIN public.escrow_contracts c ON c.address = p.owner
    WHERE p.slug = collection_slug
      AND (
        (p.owner = fetch_ethscriptions_owned_with_listings_and_bids.address AND c.address IS NULL)
        OR (c.address IS NOT NULL AND p."prevOwner" = fetch_ethscriptions_owned_with_listings_and_bids.address)
      );
$function$;

-- Sepolia also keeps items locked in the old test bridge, as before.
CREATE OR REPLACE FUNCTION public.fetch_ethscriptions_owned_with_listings_and_bids_sepolia(address text, collection_slug text DEFAULT 'ethereum-phunks'::text)
 RETURNS TABLE(ethscription json)
 LANGUAGE sql
 STABLE
AS $function$
    SELECT json_build_object(
        'ethscription', json_strip_nulls(json_build_object(
            'hashId', p."hashId",
            'tokenId', p."tokenId",
            'owner', p.owner,
            'prevOwner', p."prevOwner",
            'slug', p.slug,
            'sha', p.sha
        )),
        'escrow', CASE WHEN c.address IS NOT NULL THEN json_build_object('venue', c.venue, 'address', c.address) END,
        'listing', (
            SELECT json_agg(json_strip_nulls(json_build_object(
                'createdAt', l."createdAt",
                'minValue', l."minValue",
                'venue', l.venue
            )))
            FROM public.listings_sepolia l
            WHERE l."hashId" = p."hashId"
              AND l."toAddress" = '0x0000000000000000000000000000000000000000'
              AND l.venue = c.venue
              AND l."listedBy" = p."prevOwner"
        )
    )
    FROM public.ethscriptions_sepolia p
    LEFT JOIN public.escrow_contracts_sepolia c ON c.address = p.owner
    WHERE p.slug = collection_slug
      AND (
        (p.owner = fetch_ethscriptions_owned_with_listings_and_bids_sepolia.address AND c.address IS NULL)
        OR (c.address IS NOT NULL AND p."prevOwner" = fetch_ethscriptions_owned_with_listings_and_bids_sepolia.address)
        OR (p.owner = '0x1565f60d2469f18bbcc96b2c29220412f2fe98bd' AND p."prevOwner" = fetch_ethscriptions_owned_with_listings_and_bids_sepolia.address)
      );
$function$;

CREATE OR REPLACE FUNCTION public.addresses_are_holders(addresses text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
    WITH filtered AS (
      SELECT
        CASE WHEN c.address IS NOT NULL THEN es."prevOwner" ELSE es.owner END AS effective_owner,
        es."tokenId",
        es."hashId",
        es.sha,
        es.owner,
        es."prevOwner",
        es."createdAt"
      FROM public.ethscriptions es
      LEFT JOIN public.escrow_contracts c ON c.address = es.owner
      WHERE (es.owner = ANY(addresses) AND c.address IS NULL)
         OR (es."prevOwner" = ANY(addresses) AND c.address IS NOT NULL)
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY effective_owner ORDER BY "createdAt" ASC) AS rn
      FROM filtered
    )
    SELECT jsonb_agg(jsonb_build_object(
      'address', effective_owner,
      'item', jsonb_build_object(
        'tokenId', "tokenId",
        'hashId', "hashId",
        'sha', sha,
        'owner', owner,
        'prevOwner', "prevOwner"
      )
    ))
    FROM ranked
    WHERE rn = 1;
$function$;

CREATE OR REPLACE FUNCTION public.addresses_are_holders_sepolia(addresses text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
    WITH filtered AS (
      SELECT
        CASE WHEN c.address IS NOT NULL THEN es."prevOwner" ELSE es.owner END AS effective_owner,
        es."tokenId",
        es."hashId",
        es.sha,
        es.owner,
        es."prevOwner",
        es."createdAt"
      FROM public.ethscriptions_sepolia es
      LEFT JOIN public.escrow_contracts_sepolia c ON c.address = es.owner
      WHERE (es.owner = ANY(addresses) AND c.address IS NULL)
         OR (es."prevOwner" = ANY(addresses) AND c.address IS NOT NULL)
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY effective_owner ORDER BY "createdAt" ASC) AS rn
      FROM filtered
    )
    SELECT jsonb_agg(jsonb_build_object(
      'address', effective_owner,
      'item', jsonb_build_object(
        'tokenId', "tokenId",
        'hashId', "hashId",
        'sha', sha,
        'owner', owner,
        'prevOwner', "prevOwner"
      )
    ))
    FROM ranked
    WHERE rn = 1;
$function$;

------------------------------------------------------------------------------------------------
-- Collection grid: only Mingo Mart listings count as for sale (and the join stays one row per item).
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fetch_all_with_pagination(p_slug text, p_from_num integer, p_to_num integer, p_filters jsonb, p_sort_by text DEFAULT 'id'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    result_json JSONB;
    total_count INTEGER;
    filter_count INTEGER;
    trait_count_filter TEXT;
    has_trait_count_filter BOOLEAN;
    collection_trait_exclusions TEXT[];
BEGIN
    SELECT ARRAY(
        SELECT jsonb_array_elements_text(c."ignoredTraitFiltersForCounts")
    )
    INTO collection_trait_exclusions
    FROM collections c
    WHERE c.slug = p_slug;

    SELECT p_filters ->> 'trait_count' INTO trait_count_filter;
    has_trait_count_filter := trait_count_filter IS NOT NULL;

    SELECT COUNT(*)
    INTO filter_count
    FROM jsonb_each(COALESCE(p_filters, '{}'::jsonb))
    WHERE key != 'trait_count';

    SELECT COUNT(*)
    INTO total_count
    FROM ethscriptions e
    LEFT JOIN attributes a ON e.sha = a.sha
    WHERE e.slug = p_slug
    AND (filter_count = 0 OR public.attributes_match_trait_filters(a.values, p_filters))
    AND (
        NOT has_trait_count_filter OR
        CASE
            WHEN trait_count_filter LIKE '%-%' AND trait_count_filter ~ '^[0-9]+-[0-9]+$' THEN
                (
                    SELECT COALESCE(SUM(
                        CASE
                            WHEN jsonb_typeof(a.values -> k) = 'array'
                            THEN jsonb_array_length(a.values -> k)
                            ELSE 1
                        END
                    ), 0)
                    FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                    WHERE k <> ALL(collection_trait_exclusions)
                ) BETWEEN
                    split_part(trait_count_filter, '-', 1)::INTEGER AND
                    split_part(trait_count_filter, '-', 2)::INTEGER
            ELSE
                (
                    SELECT COALESCE(SUM(
                        CASE
                            WHEN jsonb_typeof(a.values -> k) = 'array'
                            THEN jsonb_array_length(a.values -> k)
                            ELSE 1
                        END
                    ), 0)
                    FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                    WHERE k <> ALL(collection_trait_exclusions)
                ) = trait_count_filter::INTEGER
        END
    );

    SELECT
        jsonb_build_object(
            'data', COALESCE(jsonb_agg(t.*), '[]'::jsonb),
            'total_count', total_count
        )
    INTO result_json
    FROM (
        SELECT
            e."tokenId",
            e.slug,
            e."hashId",
            e.sha,
            CASE
                WHEN l."hashId" IS NOT NULL THEN
                    jsonb_build_object(
                        'listed', l.listed,
                        'toAddress', l."toAddress",
                        'minValue', l."minValue",
                        'listedBy', l."listedBy",
                        'txHash', l."txHash",
                        'l2', l.l2,
                        'createdAt', l."createdAt"
                    )
                ELSE NULL
            END as listing
        FROM ethscriptions e
        LEFT JOIN attributes a ON e.sha = a.sha
        LEFT JOIN listings l ON e."hashId" = l."hashId" AND l.venue = 'mingomart-market'
        WHERE e.slug = p_slug
        AND (filter_count = 0 OR public.attributes_match_trait_filters(a.values, p_filters))
        AND (
            NOT has_trait_count_filter OR
            CASE
                WHEN trait_count_filter LIKE '%-%' AND trait_count_filter ~ '^[0-9]+-[0-9]+$' THEN
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN jsonb_typeof(a.values -> k) = 'array'
                                THEN jsonb_array_length(a.values -> k)
                                ELSE 1
                            END
                        ), 0)
                        FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                        WHERE k <> ALL(collection_trait_exclusions)
                    ) BETWEEN
                        split_part(trait_count_filter, '-', 1)::INTEGER AND
                        split_part(trait_count_filter, '-', 2)::INTEGER
                ELSE
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN jsonb_typeof(a.values -> k) = 'array'
                                THEN jsonb_array_length(a.values -> k)
                                ELSE 1
                            END
                        ), 0)
                        FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                        WHERE k <> ALL(collection_trait_exclusions)
                    ) = trait_count_filter::INTEGER
            END
        )
        ORDER BY
            CASE
                WHEN p_sort_by = 'price-low' THEN COALESCE(l."minValue"::numeric, 999999999999)
                WHEN p_sort_by = 'price-high' THEN -COALESCE(l."minValue"::numeric, -1)
                WHEN p_sort_by = 'rank-low' THEN -COALESCE((a.values ->> 'Rank')::numeric, -1)
                WHEN p_sort_by = 'rank-high' THEN COALESCE((a.values ->> 'Rank')::numeric, 999999)
                WHEN p_sort_by = 'recently-listed' THEN -EXTRACT(EPOCH FROM COALESCE(l."createdAt", '1970-01-01'::timestamp))
                ELSE e."tokenId"::numeric
            END,
            e."tokenId"
        LIMIT p_to_num - p_from_num + 1
        OFFSET p_from_num
    ) t;

    RETURN result_json;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fetch_all_with_pagination_sepolia(p_slug text, p_from_num integer, p_to_num integer, p_filters jsonb, p_sort_by text DEFAULT 'id'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    result_json JSONB;
    total_count INTEGER;
    filter_count INTEGER;
    trait_count_filter TEXT;
    has_trait_count_filter BOOLEAN;
    collection_trait_exclusions TEXT[];
BEGIN
    SELECT ARRAY(
        SELECT jsonb_array_elements_text(c."ignoredTraitFiltersForCounts")
    )
    INTO collection_trait_exclusions
    FROM collections_sepolia c
    WHERE c.slug = p_slug;

    SELECT p_filters ->> 'trait_count' INTO trait_count_filter;
    has_trait_count_filter := trait_count_filter IS NOT NULL;

    SELECT COUNT(*)
    INTO filter_count
    FROM jsonb_each(COALESCE(p_filters, '{}'::jsonb))
    WHERE key != 'trait_count';

    SELECT COUNT(*)
    INTO total_count
    FROM ethscriptions_sepolia e
    LEFT JOIN attributes a ON e.sha = a.sha
    WHERE e.slug = p_slug
    AND (filter_count = 0 OR public.attributes_match_trait_filters(a.values, p_filters))
    AND (
        NOT has_trait_count_filter OR
        CASE
            WHEN trait_count_filter LIKE '%-%' AND trait_count_filter ~ '^[0-9]+-[0-9]+$' THEN
                (
                    SELECT COALESCE(SUM(
                        CASE
                            WHEN jsonb_typeof(a.values -> k) = 'array'
                            THEN jsonb_array_length(a.values -> k)
                            ELSE 1
                        END
                    ), 0)
                    FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                    WHERE k <> ALL(collection_trait_exclusions)
                ) BETWEEN
                    split_part(trait_count_filter, '-', 1)::INTEGER AND
                    split_part(trait_count_filter, '-', 2)::INTEGER
            ELSE
                (
                    SELECT COALESCE(SUM(
                        CASE
                            WHEN jsonb_typeof(a.values -> k) = 'array'
                            THEN jsonb_array_length(a.values -> k)
                            ELSE 1
                        END
                    ), 0)
                    FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                    WHERE k <> ALL(collection_trait_exclusions)
                ) = trait_count_filter::INTEGER
        END
    );

    SELECT
        jsonb_build_object(
            'data', COALESCE(jsonb_agg(t.*), '[]'::jsonb),
            'total_count', total_count
        )
    INTO result_json
    FROM (
        SELECT
            e."tokenId",
            e.slug,
            e."hashId",
            e.sha,
            CASE
                WHEN l."hashId" IS NOT NULL THEN
                    jsonb_build_object(
                        'listed', l.listed,
                        'toAddress', l."toAddress",
                        'minValue', l."minValue",
                        'listedBy', l."listedBy",
                        'txHash', l."txHash",
                        'l2', l.l2,
                        'createdAt', l."createdAt"
                    )
                ELSE NULL
            END as listing
        FROM ethscriptions_sepolia e
        LEFT JOIN attributes a ON e.sha = a.sha
        LEFT JOIN listings_sepolia l ON e."hashId" = l."hashId" AND l.venue = 'mingomart-market'
        WHERE e.slug = p_slug
        AND (filter_count = 0 OR public.attributes_match_trait_filters(a.values, p_filters))
        AND (
            NOT has_trait_count_filter OR
            CASE
                WHEN trait_count_filter LIKE '%-%' AND trait_count_filter ~ '^[0-9]+-[0-9]+$' THEN
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN jsonb_typeof(a.values -> k) = 'array'
                                THEN jsonb_array_length(a.values -> k)
                                ELSE 1
                            END
                        ), 0)
                        FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                        WHERE k <> ALL(collection_trait_exclusions)
                    ) BETWEEN
                        split_part(trait_count_filter, '-', 1)::INTEGER AND
                        split_part(trait_count_filter, '-', 2)::INTEGER
                ELSE
                    (
                        SELECT COALESCE(SUM(
                            CASE
                                WHEN jsonb_typeof(a.values -> k) = 'array'
                                THEN jsonb_array_length(a.values -> k)
                                ELSE 1
                            END
                        ), 0)
                        FROM jsonb_object_keys(COALESCE(a.values, '{}'::jsonb)) k
                        WHERE k <> ALL(collection_trait_exclusions)
                    ) = trait_count_filter::INTEGER
            END
        )
        ORDER BY
            CASE
                WHEN p_sort_by = 'price-low' THEN COALESCE(l."minValue"::numeric, 999999999999)
                WHEN p_sort_by = 'price-high' THEN -COALESCE(l."minValue"::numeric, -1)
                WHEN p_sort_by = 'rank-low' THEN -COALESCE((a.values ->> 'Rank')::numeric, -1)
                WHEN p_sort_by = 'rank-high' THEN COALESCE((a.values ->> 'Rank')::numeric, 999999)
                WHEN p_sort_by = 'recently-listed' THEN -EXTRACT(EPOCH FROM COALESCE(l."createdAt", '1970-01-01'::timestamp))
                ELSE e."tokenId"::numeric
            END,
            e."tokenId"
        LIMIT p_to_num - p_from_num + 1
        OFFSET p_from_num
    ) t;

    RETURN result_json;
END;
$function$;
