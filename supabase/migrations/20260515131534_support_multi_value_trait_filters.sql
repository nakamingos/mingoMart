-- Support selecting multiple values within the same trait filter.
-- Different trait keys still combine with AND; values inside one trait combine with OR.

CREATE OR REPLACE FUNCTION public.attributes_match_trait_filters(
    p_values jsonb,
    p_filters jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE((
        SELECT bool_and(
            EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                    CASE
                        WHEN jsonb_typeof(f.value) = 'array' THEN f.value
                        ELSE jsonb_build_array(f.value)
                    END
                ) selected(value)
                WHERE selected.value IS NOT NULL
                AND CASE
                    WHEN selected.value = 'none' THEN
                        NOT (COALESCE(p_values, '{}'::jsonb) ? f.key)
                    WHEN selected.value LIKE '%-%' AND selected.value ~ '^[0-9]+-[0-9]+$' THEN
                        CASE jsonb_typeof(COALESCE(p_values, '{}'::jsonb) -> f.key)
                            WHEN 'number' THEN
                                (COALESCE(p_values, '{}'::jsonb) ->> f.key)::INTEGER BETWEEN
                                    split_part(selected.value, '-', 1)::INTEGER AND
                                    split_part(selected.value, '-', 2)::INTEGER
                            WHEN 'string' THEN
                                CASE
                                    WHEN COALESCE(p_values, '{}'::jsonb) ->> f.key ~ '^[0-9]+$' THEN
                                        (COALESCE(p_values, '{}'::jsonb) ->> f.key)::INTEGER BETWEEN
                                            split_part(selected.value, '-', 1)::INTEGER AND
                                            split_part(selected.value, '-', 2)::INTEGER
                                    ELSE
                                        COALESCE(p_values, '{}'::jsonb) ->> f.key = selected.value
                                END
                            WHEN 'array' THEN
                                EXISTS (
                                    SELECT 1
                                    FROM jsonb_array_elements_text(COALESCE(p_values, '{}'::jsonb) -> f.key) attr(value)
                                    WHERE attr.value ~ '^[0-9]+$'
                                    AND attr.value::INTEGER BETWEEN
                                        split_part(selected.value, '-', 1)::INTEGER AND
                                        split_part(selected.value, '-', 2)::INTEGER
                                )
                            ELSE
                                false
                        END
                    ELSE
                        CASE jsonb_typeof(COALESCE(p_values, '{}'::jsonb) -> f.key)
                            WHEN 'array' THEN
                                selected.value IN (
                                    SELECT jsonb_array_elements_text(COALESCE(p_values, '{}'::jsonb) -> f.key)
                                )
                            ELSE
                                COALESCE(p_values, '{}'::jsonb) ->> f.key = selected.value
                        END
                END
            )
        )
        FROM jsonb_each(COALESCE(p_filters, '{}'::jsonb)) f
        WHERE f.key != 'trait_count'
    ), true);
$$;

GRANT ALL ON FUNCTION public.attributes_match_trait_filters(jsonb, jsonb) TO anon;
GRANT ALL ON FUNCTION public.attributes_match_trait_filters(jsonb, jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.attributes_match_trait_filters(jsonb, jsonb) TO service_role;

DROP FUNCTION IF EXISTS fetch_all_with_pagination_new(text, integer, integer, jsonb, text);

CREATE OR REPLACE FUNCTION fetch_all_with_pagination_new(
    p_slug text,
    p_from_num integer,
    p_to_num integer,
    p_filters jsonb,
    p_sort_by text DEFAULT 'id'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
    LEFT JOIN attributes_new a ON e.sha = a.sha
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
        LEFT JOIN attributes_new a ON e.sha = a.sha
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
$$;

DROP FUNCTION IF EXISTS fetch_all_with_pagination_new_sepolia(text, integer, integer, jsonb, text);

CREATE OR REPLACE FUNCTION fetch_all_with_pagination_new_sepolia(
    p_slug text,
    p_from_num integer,
    p_to_num integer,
    p_filters jsonb,
    p_sort_by text DEFAULT 'id'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
    LEFT JOIN attributes_new a ON e.sha = a.sha
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
        LEFT JOIN attributes_new a ON e.sha = a.sha
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
$$;
