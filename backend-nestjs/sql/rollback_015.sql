-- Rollback de 015_transferencias_cuentas_propias_y_prestamos.sql
DROP INDEX IF EXISTS idx_prestamos_notificacion_correo;
DROP INDEX IF EXISTS idx_prestamos_tx_desembolso;

ALTER TABLE "Prestamos"
  DROP COLUMN IF EXISTS cuenta_origen_desembolso_id,
  DROP COLUMN IF EXISTS notificacion_correo_id,
  DROP COLUMN IF EXISTS transaccion_desembolso_id;

DROP INDEX IF EXISTS idx_transacciones_transferencia_interna;
DROP INDEX IF EXISTS idx_transacciones_espejo_id;

ALTER TABLE "Transacciones"
  DROP COLUMN IF EXISTS transaccion_espejo_id,
  DROP COLUMN IF EXISTS cuenta_contraparte_id,
  DROP COLUMN IF EXISTS es_transferencia_interna;
