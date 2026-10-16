-- =============================================================================
-- 006 · Tarjetas de crédito y de débito; vínculo tarjeta → cuenta; productos «genéricos» y periodo de uso
-- =============================================================================
-- IDEMPOTENTE. Solo DDL aditivo: no borra ni reescribe ninguna fila ni columna previa. Se aplica después de 005 con
-- `node scripts/aplicar-sql.js`.
--
--  · `Tarjetas` sigue siendo la línea de la tarjeta (con sus plásticos en `TarjetaPlasticos`). Ahora puede ser de CRÉDITO (como hasta
--    hoy) o de DÉBITO; una tarjeta de débito cuelga de una cuenta (`cuenta_id`, obligatorio) y la de crédito puede tener una cuenta
--    opcional (la que la paga). Una cuenta puede tener VARIAS tarjetas (relación 1:N).
--  · `alias` = nombre corto para mostrar («Débito *3698»). `es_generica` marca el producto que recibe lo que el banco avisa SIN
--    números (la tarjeta de crédito «sin número» y la cuenta de ahorros «sin número»).
--  · `CuentasFinancieras.fecha_inicio_uso / fecha_fin_uso` = periodo en que se ha usado la cuenta (para la línea de tiempo).
--    Las tarjetas lo toman de las vigencias de sus plásticos.
-- =============================================================================

ALTER TABLE "Tarjetas"
  ADD COLUMN IF NOT EXISTS tipo_tarjeta varchar(7) NOT NULL DEFAULT 'CREDITO',
  ADD COLUMN IF NOT EXISTS cuenta_id    int8,
  ADD COLUMN IF NOT EXISTS alias        varchar,
  ADD COLUMN IF NOT EXISTS es_generica  boolean NOT NULL DEFAULT false;

ALTER TABLE "CuentasFinancieras"
  ADD COLUMN IF NOT EXISTS es_generica      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_inicio_uso date,
  ADD COLUMN IF NOT EXISTS fecha_fin_uso    date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tarjetas_tipo') THEN
    ALTER TABLE "Tarjetas" ADD CONSTRAINT chk_tarjetas_tipo CHECK (tipo_tarjeta IN ('CREDITO', 'DEBITO'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tarjetas_cuenta') THEN
    -- RESTRICT: no se puede borrar una cuenta que todavía tiene tarjetas.
    ALTER TABLE "Tarjetas" ADD CONSTRAINT fk_tarjetas_cuenta FOREIGN KEY (cuenta_id) REFERENCES "CuentasFinancieras"(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tarjeta_debito_cuenta') THEN
    ALTER TABLE "Tarjetas" ADD CONSTRAINT chk_tarjeta_debito_cuenta CHECK (tipo_tarjeta = 'CREDITO' OR cuenta_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cuentas_periodo_uso') THEN
    ALTER TABLE "CuentasFinancieras" ADD CONSTRAINT chk_cuentas_periodo_uso CHECK (fecha_inicio_uso IS NULL OR fecha_fin_uso IS NULL OR fecha_inicio_uso <= fecha_fin_uso);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tarjetas_cuenta ON "Tarjetas" (cuenta_id) WHERE cuenta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tarjetas_owner_tipo ON "Tarjetas" (owner_user_id, tipo_tarjeta);
