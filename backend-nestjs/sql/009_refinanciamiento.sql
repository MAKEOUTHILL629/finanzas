-- =============================================================================
-- 009 · Refinanciamiento / unificación de deuda de tarjetas de crédito (plan V2, fase 5)
-- =============================================================================
-- IDEMPOTENTE y ADITIVA (solo agrega columnas, una FK, dos CHECK y un índice a "ComprasCredito"; no toca ninguna fila).
--
-- Contexto: cuando el banco llama a «unificar / rediferir» lo que se debe en una tarjeta, las compras originales dejan de cobrarse
-- por separado y pasan a pagarse con UNA obligación nueva (N cuotas, otra tasa, cuota fija). Hasta ahora eso se registraba a mano:
-- las originales quedaban en estado «Ajuste Interes» y la nueva era una compra «Ajuste de Interes …», sin vínculo entre ellas.
--
--   refinanciamiento_id   en una compra ABSORBIDA: la compra «maestra» que la unificó (trazabilidad; NULL = no absorbida)
--   es_refinanciamiento   la compra es la obligación nueva que unifica a otras
--   saldo_refinanciado    en una absorbida: cuánto capital pendiente se llevó la maestra
--   sistema_amortizacion  CAPITAL_FIJO (compras normales: capital fijo + interés sobre saldo) | FRANCES (cuota fija, como el banco)
--   cuota_fija_pactada    cuota que dio el banco (con seguros/ajustes), si no es la calculada por la fórmula
-- =============================================================================

ALTER TABLE "ComprasCredito"
  ADD COLUMN IF NOT EXISTS refinanciamiento_id  bigint,
  ADD COLUMN IF NOT EXISTS es_refinanciamiento  boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS saldo_refinanciado   numeric,
  ADD COLUMN IF NOT EXISTS sistema_amortizacion varchar(12)   NOT NULL DEFAULT 'CAPITAL_FIJO',
  ADD COLUMN IF NOT EXISTS cuota_fija_pactada   numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_compras_refinanciamiento') THEN
    -- Si se borra la maestra las originales quedan sin vínculo (la aplicación lo impide mientras existan: primero se deshace).
    ALTER TABLE "ComprasCredito"
      ADD CONSTRAINT fk_compras_refinanciamiento FOREIGN KEY (refinanciamiento_id) REFERENCES "ComprasCredito" (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_compras_refinanciamiento_no_propio') THEN
    ALTER TABLE "ComprasCredito"
      ADD CONSTRAINT chk_compras_refinanciamiento_no_propio CHECK (refinanciamiento_id IS NULL OR refinanciamiento_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_compras_sistema_amortizacion') THEN
    ALTER TABLE "ComprasCredito"
      ADD CONSTRAINT chk_compras_sistema_amortizacion CHECK (sistema_amortizacion IN ('CAPITAL_FIJO', 'FRANCES'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_compras_refinanciamiento ON "ComprasCredito" (refinanciamiento_id) WHERE refinanciamiento_id IS NOT NULL;
