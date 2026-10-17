-- Reversa MANUAL de 010 (no la aplica scripts/aplicar-sql.js).
-- Antes: los asientos `AJUSTE_DESCUENTO` ya creados NO se borran aquí (son parte del libro de deudas): si no los quieres,
-- anúlalos primero (UPDATE "MovimientosDeudaPersona" SET estado = 'ANULADO' WHERE tipo_movimiento = 'AJUSTE_DESCUENTO').
DROP INDEX IF EXISTS idx_mov_deuda_ajuste_cobro;
ALTER TABLE "ReportesPagoPersona" DROP COLUMN IF EXISTS saldo_al_reportar;
DROP TABLE IF EXISTS "ObjecionesCobro";
DROP TABLE IF EXISTS "MetodosPagoUsuario";
