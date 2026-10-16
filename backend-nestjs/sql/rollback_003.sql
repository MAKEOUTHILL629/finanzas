-- =============================================================================
-- Reversa MANUAL de 003_correos_inteligentes_cobros.sql. No la aplica `scripts/aplicar-sql.js`.
-- ADVERTENCIA: borra las tablas de cobros/enlaces/reportes (y con ellas los comprobantes) y las columnas añadidas.
-- Los cargos `CARGO_COBRO_PUNTUAL` del sub-ledger se conservan (solo pierden su referencia al cobro).
-- =============================================================================
BEGIN;

DROP TABLE IF EXISTS "ReportesPagoPersona" CASCADE;
DROP TABLE IF EXISTS "EnlacesCobroPersona" CASCADE;
DROP INDEX IF EXISTS idx_mov_deuda_cobro_puntual;
ALTER TABLE "MovimientosDeudaPersona" DROP COLUMN IF EXISTS cobro_puntual_id;
DROP TABLE IF EXISTS "CobrosPuntualesPersonas" CASCADE;
DROP TABLE IF EXISTS "CobrosPuntuales" CASCADE;

DROP INDEX IF EXISTS idx_notif_owner_ultimos4;
DROP INDEX IF EXISTS idx_notif_owner_comercio;
DROP INDEX IF EXISTS idx_notif_compra;
DROP INDEX IF EXISTS idx_notif_transaccion;
DROP INDEX IF EXISTS idx_notif_owner_fecha;
ALTER TABLE "NotificacionesCorreo" DROP CONSTRAINT IF EXISTS ck_notificaciones_correo_vinculo;
ALTER TABLE "NotificacionesCorreo"
  DROP COLUMN IF EXISTS ultimos_4,
  DROP COLUMN IF EXISTS comercio_normalizado,
  DROP COLUMN IF EXISTS monto_original,
  DROP COLUMN IF EXISTS moneda,
  DROP COLUMN IF EXISTS tarjeta_id,
  DROP COLUMN IF EXISTS cuenta_id,
  DROP COLUMN IF EXISTS persona_id,
  DROP COLUMN IF EXISTS vinculo,
  DROP COLUMN IF EXISTS notificacion_original_id;

DROP INDEX IF EXISTS ux_cuentas_financieras_principal;
ALTER TABLE "CuentasFinancieras" DROP COLUMN IF EXISTS es_principal;
ALTER TABLE "Tarjetas" DROP COLUMN IF EXISTS ultimos_4_digitos;

COMMIT;
