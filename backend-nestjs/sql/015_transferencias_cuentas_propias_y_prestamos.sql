-- =============================================================================
-- 015 — Iteración 2 (Fases 4 y 5):
--   Fase 4: Transferencias entre cuentas propias (par espejo en Transacciones)
--   Fase 5: Asociación bidireccional de Préstamos con Transferencias y Correos
-- =============================================================================

-- 1. Columnas para Transferencias entre Cuentas Propias en "Transacciones"
ALTER TABLE "Transacciones"
  ADD COLUMN IF NOT EXISTS es_transferencia_interna BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cuenta_contraparte_id BIGINT NULL REFERENCES "CuentasFinancieras"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transaccion_espejo_id BIGINT NULL REFERENCES "Transacciones"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_espejo_id
  ON "Transacciones"(transaccion_espejo_id)
  WHERE transaccion_espejo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_transferencia_interna
  ON "Transacciones"(owner_user_id, es_transferencia_interna);

-- 2. Columnas para Trazabilidad de Desembolso en "Prestamos"
ALTER TABLE "Prestamos"
  ADD COLUMN IF NOT EXISTS transaccion_desembolso_id BIGINT NULL REFERENCES "Transacciones"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notificacion_correo_id BIGINT NULL REFERENCES "NotificacionesCorreo"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cuenta_origen_desembolso_id BIGINT NULL REFERENCES "CuentasFinancieras"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prestamos_tx_desembolso
  ON "Prestamos"(transaccion_desembolso_id)
  WHERE transaccion_desembolso_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prestamos_notificacion_correo
  ON "Prestamos"(notificacion_correo_id)
  WHERE notificacion_correo_id IS NOT NULL;
