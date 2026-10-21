-- =============================================================================
-- 016 — Iteración 3 (Fase 1):
--   Persistencia de Tags (TEXT[]) y Comercio Canónico con índices GIN y B-Tree
--   en "ComprasCredito" y "Transacciones"
-- =============================================================================

ALTER TABLE "ComprasCredito"
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS comercio_canonico VARCHAR(120) NULL;

ALTER TABLE "Transacciones"
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS comercio_canonico VARCHAR(120) NULL;

CREATE INDEX IF NOT EXISTS idx_compras_credito_tags_gin
  ON "ComprasCredito" USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_transacciones_tags_gin
  ON "Transacciones" USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_compras_credito_comercio_canonico
  ON "ComprasCredito"(owner_user_id, comercio_canonico)
  WHERE comercio_canonico IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_comercio_canonico
  ON "Transacciones"(owner_user_id, comercio_canonico)
  WHERE comercio_canonico IS NOT NULL;
