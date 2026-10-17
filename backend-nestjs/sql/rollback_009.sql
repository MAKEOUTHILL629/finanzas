-- Reversa de 009_refinanciamiento.sql. Pierde el vínculo entre las compras absorbidas y su maestra (y la marca de maestra):
-- las compras y sus cuotas NO se tocan. Si hay refinanciamientos registrados con la aplicación, antes de correr esto deshazlos
-- (DELETE /api/refinanciamientos/:id) para que las compras originales vuelvan a cobrarse.
DROP INDEX IF EXISTS idx_compras_refinanciamiento;
ALTER TABLE "ComprasCredito"
  DROP CONSTRAINT IF EXISTS chk_compras_sistema_amortizacion,
  DROP CONSTRAINT IF EXISTS chk_compras_refinanciamiento_no_propio,
  DROP CONSTRAINT IF EXISTS fk_compras_refinanciamiento;
ALTER TABLE "ComprasCredito"
  DROP COLUMN IF EXISTS cuota_fija_pactada,
  DROP COLUMN IF EXISTS sistema_amortizacion,
  DROP COLUMN IF EXISTS saldo_refinanciado,
  DROP COLUMN IF EXISTS es_refinanciamiento,
  DROP COLUMN IF EXISTS refinanciamiento_id;
