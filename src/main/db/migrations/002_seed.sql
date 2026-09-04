-- ============================================================
-- miniClaudio · semilla · versión 2
-- Idempotente: INSERT OR IGNORE. Nunca pisa lo que el usuario haya cambiado.
-- docs/design/02-esquema-bd.md §2.1
-- ============================================================

INSERT OR IGNORE INTO model_prices
 (model_key,        input_per_mtok, output_per_mtok, cache_write_5m_per_mtok,
  cache_write_1h_per_mtok, cache_read_per_mtok, valid_from,             source) VALUES
 ('claude-opus-5',   5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-opus-4-8', 5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-sonnet-5', 2.00, 10.00, 2.50,  4.00, 0.20, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-haiku-4-5',1.00,  5.00, 1.25,  2.00, 0.10, '2000-01-01T00:00:00Z', 'seed'),
 ('__default__',     5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed');

INSERT OR IGNORE INTO plans (tier_id, organization_type, display_name, monthly_usd, updated_at) VALUES
 ('default_claude_max_20x', 'claude_max',  'Max 20×',  200.0, '2026-09-03T00:00:00Z'),
 ('default_claude_max_5x',  'claude_max',  'Max 5×',   100.0, '2026-09-03T00:00:00Z'),
 ('default_claude_pro',     'claude_pro',  'Pro',       20.0, '2026-09-03T00:00:00Z'),
 ('default_claude_free',    'claude_free', 'Free',       0.0, '2026-09-03T00:00:00Z');
