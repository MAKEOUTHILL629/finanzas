-- =============================================================================
-- Reversa MANUAL de 004_plasticos_tarjeta.sql. No la aplica `scripts/aplicar-sql.js`.
-- ADVERTENCIA: borra la tabla de plásticos (su historial de reposiciones) y la columna `ComprasCredito.plastico_id`.
-- Las compras, las cuotas y `Tarjetas.ultimos_4_digitos` (lista con todos los plásticos) NO se tocan.
-- =============================================================================
BEGIN;

DROP INDEX IF EXISTS idx_compras_credito_plastico;
ALTER TABLE "ComprasCredito" DROP COLUMN IF EXISTS plastico_id;
DROP TABLE IF EXISTS "TarjetaPlasticos" CASCADE;

COMMIT;
