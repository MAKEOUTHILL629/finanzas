-- =============================================================================
-- 017 · Refinanciamiento por fecha de corte ("barrido automático") — Iteración 3, Fase 3
-- =============================================================================
-- IDEMPOTENTE y ADITIVA (solo agrega columnas a "ComprasCredito"; no toca ninguna fila).
--
-- La obligación nueva ("maestra", es_refinanciamiento = true) guarda cómo nació:
--   modo_unificacion          'SELECCION_MANUAL' (flujo histórico) | 'BARRIDO_FECHA_CORTE'
--   fecha_corte_unificacion   fecha hasta la que el banco absorbió la deuda (ej. 2026-09-07)
--   capital_teorico_absorbido suma de saldos de capital en BD de las compras barridas al corte
--   ajuste_banco_capitalizado montoUnificadoBanco − capitalTeorico (intereses corrientes,
--                             seguros o cuotas de manejo que el banco sumó al unificar)
-- =============================================================================

ALTER TABLE "ComprasCredito"
  ADD COLUMN IF NOT EXISTS modo_unificacion varchar(30) NOT NULL DEFAULT 'SELECCION_MANUAL',
  ADD COLUMN IF NOT EXISTS fecha_corte_unificacion date,
  ADD COLUMN IF NOT EXISTS capital_teorico_absorbido numeric,
  ADD COLUMN IF NOT EXISTS ajuste_banco_capitalizado numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_compras_modo_unificacion') THEN
    ALTER TABLE "ComprasCredito"
      ADD CONSTRAINT chk_compras_modo_unificacion CHECK (modo_unificacion IN ('SELECCION_MANUAL', 'BARRIDO_FECHA_CORTE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_compras_modo_unificacion
  ON "ComprasCredito" (modo_unificacion, fecha_corte_unificacion)
  WHERE es_refinanciamiento = true;
