-- =============================================================================
-- Reversa MANUAL de 006 y 007 (no la aplica scripts/aplicar-sql.js). Revisa antes de ejecutar.
-- =============================================================================
BEGIN;

-- 007 · semilla: solo lo que creó (plásticos con la nota de la semilla y sus líneas/cuentas si quedaron vacías).
DELETE FROM "TarjetaPlasticos" p
 WHERE p.notas LIKE 'Sembrado por el plan V2%'
   AND NOT EXISTS (SELECT 1 FROM "ComprasCredito" c WHERE c.plastico_id = p.id);

DELETE FROM "Tarjetas" t
 WHERE (t.es_generica OR t.tipo_tarjeta = 'DEBITO' OR t.alias IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM "TarjetaPlasticos" p WHERE p.tarjeta_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM "ComprasCredito" c WHERE c.tarjeta = t.id)
   AND NOT EXISTS (SELECT 1 FROM "Transacciones" x WHERE x.tarjeta_pagada_id = t.id);

DELETE FROM "CuentasFinancieras" c
 WHERE c.es_generica
   AND NOT EXISTS (SELECT 1 FROM "Transacciones" x WHERE x.cuenta_origen_id = c.id OR x.cuenta_destino_id = c.id);

-- 006 · DDL
ALTER TABLE "Tarjetas" DROP CONSTRAINT IF EXISTS chk_tarjeta_debito_cuenta;
ALTER TABLE "Tarjetas" DROP CONSTRAINT IF EXISTS fk_tarjetas_cuenta;
ALTER TABLE "Tarjetas" DROP CONSTRAINT IF EXISTS chk_tarjetas_tipo;
DROP INDEX IF EXISTS idx_tarjetas_cuenta;
DROP INDEX IF EXISTS idx_tarjetas_owner_tipo;
ALTER TABLE "Tarjetas" DROP COLUMN IF EXISTS tipo_tarjeta, DROP COLUMN IF EXISTS cuenta_id, DROP COLUMN IF EXISTS alias, DROP COLUMN IF EXISTS es_generica;
ALTER TABLE "CuentasFinancieras" DROP CONSTRAINT IF EXISTS chk_cuentas_periodo_uso;
ALTER TABLE "CuentasFinancieras" DROP COLUMN IF EXISTS es_generica, DROP COLUMN IF EXISTS fecha_inicio_uso, DROP COLUMN IF EXISTS fecha_fin_uso;

COMMIT;
