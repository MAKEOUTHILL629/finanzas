-- Reversa manual de 011 (borra tags/comercio_canonico y las tablas de etiquetas/reglas).
DROP TABLE IF EXISTS "ReglasAutoTag";
DROP TABLE IF EXISTS "Etiquetas";
ALTER TABLE "ComprasCredito" DROP COLUMN IF EXISTS tags, DROP COLUMN IF EXISTS comercio_canonico;
ALTER TABLE "Transacciones" DROP COLUMN IF EXISTS tags, DROP COLUMN IF EXISTS comercio_canonico;
