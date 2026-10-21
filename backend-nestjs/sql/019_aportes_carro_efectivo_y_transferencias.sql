-- =============================================================================
-- 019 · Aportes del carro: efectivo vs. transferencia — Iteración 3, Fase 6
-- =============================================================================
-- IDEMPOTENTE y ADITIVA.
--
-- "AportesDetalle" ya traía `metodo` (EFECTIVO/TRANSFERENCIA/CRUCE_CUENTAS/…),
-- `cuenta_financiera_id` y `transaccion_id` (sql/002). Esta migración agrega la
-- clasificación binaria explícita que pide la Fase 6 y la cuenta destino:
--   medio_pago       'EFECTIVO' | 'TRANSFERENCIA' (clasificación del aporte)
--   cuenta_destino_id cuenta donde entró el dinero cuando fue por transferencia
-- Se rellena desde lo histórico: TRANSFERENCIA/BANCOLOMBIA/NEQUI → TRANSFERENCIA.
-- =============================================================================

ALTER TABLE "AportesDetalle"
  ADD COLUMN IF NOT EXISTS medio_pago varchar(25) NOT NULL DEFAULT 'EFECTIVO',
  ADD COLUMN IF NOT EXISTS cuenta_destino_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aportes_detalle_medio_pago') THEN
    ALTER TABLE "AportesDetalle"
      ADD CONSTRAINT chk_aportes_detalle_medio_pago CHECK (medio_pago IN ('EFECTIVO', 'TRANSFERENCIA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_aportes_detalle_cuenta_destino') THEN
    ALTER TABLE "AportesDetalle"
      ADD CONSTRAINT fk_aportes_detalle_cuenta_destino FOREIGN KEY (cuenta_destino_id) REFERENCES "CuentasFinancieras" (id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE "AportesDetalle"
SET medio_pago = CASE WHEN UPPER(metodo) IN ('TRANSFERENCIA', 'BANCOLOMBIA', 'NEQUI') THEN 'TRANSFERENCIA' ELSE 'EFECTIVO' END
WHERE medio_pago = 'EFECTIVO';

UPDATE "AportesDetalle"
SET cuenta_destino_id = cuenta_financiera_id
WHERE cuenta_destino_id IS NULL AND cuenta_financiera_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aportes_detalle_medio_pago
  ON "AportesDetalle" (medio_pago);

CREATE INDEX IF NOT EXISTS idx_aportes_detalle_transaccion
  ON "AportesDetalle" (transaccion_id) WHERE transaccion_id IS NOT NULL;
