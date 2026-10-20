-- Reversa manual de 013.
DROP TABLE IF EXISTS "AportesColaborativosCuota";
ALTER TABLE "Tarjetas" DROP COLUMN IF EXISTS es_titular_externo, DROP COLUMN IF EXISTS titular_persona_id;
