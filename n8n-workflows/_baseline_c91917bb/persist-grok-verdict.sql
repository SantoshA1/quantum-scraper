INSERT INTO quantum.grok_verdicts (signal_id, symbol, side, content, grok_error, schema_error, schema_error_detail, latency_ms, attempts, workflow_version)
VALUES (
  NULLIF('{{ String($json.signal_id || $json.idempotency_key || '').replace(/'/g, "''") }}', ''),
  '{{ String($json.ticker || 'UNKNOWN').replace(/'/g, "''") }}',
  '{{ String($json.execution || '').toUpperCase().replace(/'/g, "''") }}',
  '{{ String(($json.choices && $json.choices[0] && $json.choices[0].message && $json.choices[0].message.content) || '{}').replace(/'/g, "''") }}'::jsonb,
  NULLIF('{{ String($json._grok_error || '').replace(/'/g, "''") }}', ''),
  {{ $json._grok_schema_error ? 'true' : 'false' }},
  NULLIF('{{ String($json._grok_schema_error_detail || '').replace(/'/g, "''") }}', ''),
  {{ Number($json._grok_latency_ms) || 'NULL' }},
  {{ Number($json._grok_attempts) || 'NULL' }},
  'grok-sig-v4.3'
);