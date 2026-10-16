-- =============================================================================
-- 005 · Índices en las claves foráneas que no tenían (rendimiento)
-- =============================================================================
-- IDEMPOTENTE. Solo `CREATE INDEX IF NOT EXISTS`: no toca ninguna fila ni columna. Se aplica después de 004 con
-- `node scripts/aplicar-sql.js`. Reversa manual: `rollback_005.sql`.
--
-- Postgres NO indexa las claves foráneas por sí solo. Sin índice, cada JOIN por esa columna y cada borrado/actualización de la fila
-- padre (que revisa las filas hijas) recorre la tabla entera. Hoy las tablas son pequeñas (< 2 000 filas), pero los listados de
-- compras, el estado de cuenta por persona, la liquidación y el dashboard hacen joins por estas columnas y crecen cada mes.
--
--  · Una entrada por clave foránea sin índice que empiece por esa columna (detectadas en la BD real con `pg_constraint`/`pg_index`).
--  · `MovimientosDeudaPersona (cuota_detalle_id, responsable_compra_id)` va compuesto: es exactamente el cruce que usan el Trigger 6,
--    la liquidación y las cuotas de terceros para saber si una cuota ya tiene su asiento.
--  · `ComprasCredito (owner_user_id, fecha_compra DESC)` sirve el listado de compras (siempre del usuario, la más reciente primero).
-- =============================================================================

-- AportesDetalle
CREATE INDEX IF NOT EXISTS idx_fk_aportesdetalle_cuenta_financiera_id ON "AportesDetalle" (cuenta_financiera_id);
CREATE INDEX IF NOT EXISTS idx_fk_aportesdetalle_persona_id ON "AportesDetalle" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_aportesdetalle_prestamo_cruce_generado_id ON "AportesDetalle" (prestamo_cruce_generado_id);

-- AprobacionesPrestamos
CREATE INDEX IF NOT EXISTS idx_fk_aprobacionesprestamos_persona_id ON "AprobacionesPrestamos" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_aprobacionesprestamos_prestamo_id ON "AprobacionesPrestamos" (prestamo_id);

-- CargosRecurrentesPersona
CREATE INDEX IF NOT EXISTS idx_fk_cargosrecurrentespersona_persona_id ON "CargosRecurrentesPersona" (persona_id);

-- Categorias
CREATE INDEX IF NOT EXISTS idx_fk_categorias_owner_user_id ON "Categorias" (owner_user_id);

-- CobrosPuntuales
CREATE INDEX IF NOT EXISTS idx_fk_cobrospuntuales_compra_credito_id ON "CobrosPuntuales" (compra_credito_id);
CREATE INDEX IF NOT EXISTS idx_fk_cobrospuntuales_notificacion_id ON "CobrosPuntuales" (notificacion_id);
CREATE INDEX IF NOT EXISTS idx_fk_cobrospuntuales_transaccion_id ON "CobrosPuntuales" (transaccion_id);

-- ComprasCredito
CREATE INDEX IF NOT EXISTS idx_fk_comprascredito_tarjeta ON "ComprasCredito" (tarjeta);

-- CortesCobro
CREATE INDEX IF NOT EXISTS idx_fk_cortescobro_owner_user_id ON "CortesCobro" (owner_user_id);

-- CrucesDeuda
CREATE INDEX IF NOT EXISTS idx_fk_crucesdeuda_owner_user_id ON "CrucesDeuda" (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_crucesdeuda_periodo_recurrente_destino_id ON "CrucesDeuda" (periodo_recurrente_destino_id);
CREATE INDEX IF NOT EXISTS idx_fk_crucesdeuda_persona_que_abona_id ON "CrucesDeuda" (persona_que_abona_id);
CREATE INDEX IF NOT EXISTS idx_fk_crucesdeuda_persona_que_asume_deuda_id ON "CrucesDeuda" (persona_que_asume_deuda_id);
CREATE INDEX IF NOT EXISTS idx_fk_crucesdeuda_prestamo_destino_id ON "CrucesDeuda" (prestamo_destino_id);

-- CuotasDetalle
CREATE INDEX IF NOT EXISTS idx_fk_cuotasdetalle_compra ON "CuotasDetalle" (compra);

-- EnlacesCobroPersona
CREATE INDEX IF NOT EXISTS idx_fk_enlacescobropersona_persona_id ON "EnlacesCobroPersona" (persona_id);

-- MovimientosDeudaPersona
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_cruce_deuda_id ON "MovimientosDeudaPersona" (cruce_deuda_id);
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_cuota_responsable ON "MovimientosDeudaPersona" (cuota_detalle_id, responsable_compra_id);
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_periodo_recurrente_id ON "MovimientosDeudaPersona" (periodo_recurrente_id);
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_persona_id ON "MovimientosDeudaPersona" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_responsable_compra_id ON "MovimientosDeudaPersona" (responsable_compra_id);
CREATE INDEX IF NOT EXISTS idx_fk_movimientosdeudapersona_transaccion_id ON "MovimientosDeudaPersona" (transaccion_id);

-- NotificacionesCorreo
CREATE INDEX IF NOT EXISTS idx_fk_notificacionescorreo_cuenta_id ON "NotificacionesCorreo" (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_fk_notificacionescorreo_notificacion_original_id ON "NotificacionesCorreo" (notificacion_original_id);
CREATE INDEX IF NOT EXISTS idx_fk_notificacionescorreo_persona_id ON "NotificacionesCorreo" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_notificacionescorreo_tarjeta_id ON "NotificacionesCorreo" (tarjeta_id);

-- ObligacionesMes
CREATE INDEX IF NOT EXISTS idx_fk_obligacionesmes_responsable_principal_id ON "ObligacionesMes" (responsable_principal_id);

-- PeriodosRecurrentes
CREATE INDEX IF NOT EXISTS idx_fk_periodosrecurrentes_compra_credito_pago_id ON "PeriodosRecurrentes" (compra_credito_pago_id);
CREATE INDEX IF NOT EXISTS idx_fk_periodosrecurrentes_transaccion_pago_id ON "PeriodosRecurrentes" (transaccion_pago_id);

-- Personas
CREATE INDEX IF NOT EXISTS idx_fk_personas_linked_user_id ON "Personas" (linked_user_id);

-- PlantillasRecurrentes
CREATE INDEX IF NOT EXISTS idx_fk_plantillasrecurrentes_categoria_id ON "PlantillasRecurrentes" (categoria_id);
CREATE INDEX IF NOT EXISTS idx_fk_plantillasrecurrentes_cuenta_debito_default_id ON "PlantillasRecurrentes" (cuenta_debito_default_id);
CREATE INDEX IF NOT EXISTS idx_fk_plantillasrecurrentes_owner_user_id ON "PlantillasRecurrentes" (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_plantillasrecurrentes_prestamo_asociado_id ON "PlantillasRecurrentes" (prestamo_asociado_id);
CREATE INDEX IF NOT EXISTS idx_fk_plantillasrecurrentes_tarjeta_credito_default_id ON "PlantillasRecurrentes" (tarjeta_credito_default_id);

-- Prestamos
CREATE INDEX IF NOT EXISTS idx_fk_prestamos_corte_id ON "Prestamos" (corte_id);
CREATE INDEX IF NOT EXISTS idx_fk_prestamos_creado_por_persona_id ON "Prestamos" (creado_por_persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_prestamos_origen_cruce_aporte_id ON "Prestamos" (origen_cruce_aporte_id);
CREATE INDEX IF NOT EXISTS idx_fk_prestamos_responsable ON "Prestamos" (responsable);

-- ReportesPagoPersona
CREATE INDEX IF NOT EXISTS idx_fk_reportespagopersona_cuenta_destino_id ON "ReportesPagoPersona" (cuenta_destino_id);
CREATE INDEX IF NOT EXISTS idx_fk_reportespagopersona_movimiento_id ON "ReportesPagoPersona" (movimiento_id);
CREATE INDEX IF NOT EXISTS idx_fk_reportespagopersona_persona_id ON "ReportesPagoPersona" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_reportespagopersona_transaccion_id ON "ReportesPagoPersona" (transaccion_id);

-- ResponsablesComprasCredito
CREATE INDEX IF NOT EXISTS idx_fk_responsablescomprascredito_compra_credito ON "ResponsablesComprasCredito" (compra_credito);

-- ResponsablesRecurrentes
CREATE INDEX IF NOT EXISTS idx_fk_responsablesrecurrentes_persona_id ON "ResponsablesRecurrentes" (persona_id);
CREATE INDEX IF NOT EXISTS idx_fk_responsablesrecurrentes_plantilla_recurrente_id ON "ResponsablesRecurrentes" (plantilla_recurrente_id);

-- TarjetaPlasticos
CREATE INDEX IF NOT EXISTS idx_fk_tarjetaplasticos_reemplaza_a_id ON "TarjetaPlasticos" (reemplaza_a_id);

-- Tarjetas
CREATE INDEX IF NOT EXISTS idx_fk_tarjetas_owner_user_id ON "Tarjetas" (owner_user_id);

-- Transacciones
CREATE INDEX IF NOT EXISTS idx_fk_transacciones_categoria_id ON "Transacciones" (categoria_id);
CREATE INDEX IF NOT EXISTS idx_fk_transacciones_cuenta_destino_id ON "Transacciones" (cuenta_destino_id);
CREATE INDEX IF NOT EXISTS idx_fk_transacciones_cuenta_origen_id ON "Transacciones" (cuenta_origen_id);
CREATE INDEX IF NOT EXISTS idx_fk_transacciones_tarjeta_pagada_id ON "Transacciones" (tarjeta_pagada_id);

-- Listado de compras
CREATE INDEX IF NOT EXISTS idx_compras_credito_owner_fecha ON "ComprasCredito" (owner_user_id, fecha_compra DESC);

-- Red de seguridad: cualquier clave foránea que aún no tenga un índice que empiece por su columna lo recibe aquí (p. ej. las de tablas
-- que solo existen en algunas bases). En la BD real, tras los índices de arriba, este bloque no encuentra nada que crear.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT c.conrelid AS rel, c.conrelid::regclass::text AS tabla, a.attname AS columna
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%I)', left('idx_fk_' || regexp_replace(lower(fk.tabla), '[^a-z0-9_]', '', 'g') || '_' || fk.columna, 63), fk.tabla, fk.columna);
  END LOOP;
END $$;
