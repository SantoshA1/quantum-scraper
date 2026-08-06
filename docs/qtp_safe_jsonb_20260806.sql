-- Applied migration: qtp_safe_jsonb_20260806 (byte-exact record)
-- QTP 2026-08-06 — audit-escaping RCA (TSM exec 524111): exception-guarded text->jsonb.
-- A malformed payload degrades to {"__jsonb_parse_error":true,...} with the raw text
-- preserved for forensics, instead of raising and killing the whole multi-row INSERT.
-- Consumers: TSM audit builder v4.2.2+ (and any Prepare-SQL builder writing jsonb columns).
CREATE OR REPLACE FUNCTION quantum.safe_jsonb(p text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
  RETURN p::jsonb;
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('__jsonb_parse_error', true, '__error', SQLERRM, '__raw', left(p, 8000));
END $fn$;

COMMENT ON FUNCTION quantum.safe_jsonb(text) IS
'QTP gov-187 2026-08-06: guarded text->jsonb cast. Malformed input returns {"__jsonb_parse_error":true,"__error":...,"__raw":left(p,8000)} instead of raising — one bad audit row can never kill a batch again (exec 524111 RCA).';
