-- Rename public.attributes_new to public.attributes now that the legacy attributes table is gone
-- (20261125181850_drop_legacy_attributes). The foreign keys from ethscriptions/ethscriptions_sepolia
-- and the read policy follow the table automatically; the constraint and index names are tidied up
-- to match. The two plpgsql pagination functions store their bodies as text, so they are recreated
-- here (from the live production definitions) with the new table name, then renamed to drop their
-- own "_new" suffix (ALTER ... RENAME keeps their grants).

ALTER TABLE public.attributes_new RENAME TO attributes;
ALTER TABLE public.attributes RENAME CONSTRAINT attributes_new_pkey TO attributes_pkey;
ALTER INDEX public.attributes_new_attributes_idx RENAME TO attributes_values_idx;
ALTER TABLE public.ethscriptions RENAME CONSTRAINT ethscriptions_sha_fkey1 TO ethscriptions_sha_fkey;
ALTER TABLE public.ethscriptions_sepolia RENAME CONSTRAINT ethscriptions_sepolia_sha_fkey1 TO ethscriptions_sepolia_sha_fkey;

CREATE OR REPLACE FUNCTION public.fetch_all_with_pagination_new(p_slug text, p_from_num integer, p_to_num integer, p_filters jsonb, p_sort_by text DEFAULT 'id'::text)
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
        LEFT JOIN listings l ON e."hashId" = l."hashId"
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

CREATE OR REPLACE FUNCTION public.fetch_all_with_pagination_new_sepolia(p_slug text, p_from_num integer, p_to_num integer, p_filters jsonb, p_sort_by text DEFAULT 'id'::text)
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
        LEFT JOIN listings_sepolia l ON e."hashId" = l."hashId"
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

ALTER FUNCTION public.fetch_all_with_pagination_new(text, integer, integer, jsonb, text)
  RENAME TO fetch_all_with_pagination;
ALTER FUNCTION public.fetch_all_with_pagination_new_sepolia(text, integer, integer, jsonb, text)
  RENAME TO fetch_all_with_pagination_sepolia;
