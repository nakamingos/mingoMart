-- refresh_tokens was created with row-level security commented out, so the public anon key could
-- read and insert rows directly. Inserting a row with a known token hash for any wallet would let
-- someone mint a session for that wallet once refresh is enabled. Only the indexer (service role,
-- which bypasses RLS) should touch this table: enable RLS with no policies and drop the public
-- grants.

ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.refresh_tokens FROM anon, authenticated;
GRANT ALL ON TABLE public.refresh_tokens TO service_role;
