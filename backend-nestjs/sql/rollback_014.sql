-- Reversa manual de 014.
DROP TABLE IF EXISTS "AbonosPrestamoPasivo";
ALTER TABLE "Prestamos" DROP COLUMN IF EXISTS fecha_compromiso_pago, DROP COLUMN IF EXISTS cuenta_destino_tercero, DROP COLUMN IF EXISTS token_consulta_publica;
