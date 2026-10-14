-- =============================================================================
-- REVERSA de 001 y 002 (NO se aplica automáticamente: el aplicador solo toma archivos NNN_*.sql).
-- Devuelve la BD al estado anterior (auditoría del 14/10/2026): solo existían los Triggers 3 y 5 —con las
-- definiciones antiguas que se restauran abajo— y una versión antigua de `vw_ResumenObligacionesMes`.
--
--   psql … -f sql/rollback_001_002.sql        (o pegarlo en el SQL Editor de Supabase)
--
-- ATENCIÓN: borra la tabla "CargosRecurrentesPersona" y las columnas añadidas por 002 (con sus datos).
-- =============================================================================
BEGIN;

-- ─── 002 ───
DROP INDEX IF EXISTS idx_mov_deuda_cargo_recurrente;
DROP INDEX IF EXISTS idx_mov_deuda_obligacion;
ALTER TABLE "MovimientosDeudaPersona" DROP COLUMN IF EXISTS cargo_recurrente_persona_id, DROP COLUMN IF EXISTS obligacion_mes_id;
DROP TABLE IF EXISTS "CargosRecurrentesPersona";
DROP INDEX IF EXISTS idx_aportes_detalle_transaccion;
DROP INDEX IF EXISTS idx_aportes_detalle_origen;
ALTER TABLE "AportesDetalle" DROP COLUMN IF EXISTS cuenta_financiera_id, DROP COLUMN IF EXISTS transaccion_id, DROP COLUMN IF EXISTS origen_obligacion_mes_id;
DROP INDEX IF EXISTS ux_obligaciones_mes_owner_tipo_periodo;
ALTER TABLE "ObligacionesMes" DROP CONSTRAINT IF EXISTS ck_obligaciones_mes_saldo_favor_aplicado;
ALTER TABLE "ObligacionesMes" DROP COLUMN IF EXISTS saldo_a_favor_aplicado;

-- ─── 001: triggers y funciones nuevos ───
DROP TRIGGER IF EXISTS trg_set_periodo_cuota ON "CuotasDetalle";
DROP TRIGGER IF EXISTS trg_sync_update_cuota_subledger ON "CuotasDetalle";
DROP TRIGGER IF EXISTS trg_actualizar_saldo_cuenta ON "Transacciones";
DROP TRIGGER IF EXISTS trg_sync_prestamo_subledger ON "Prestamos";
DROP TRIGGER IF EXISTS trg_after_insert_responsable_tc ON "ResponsablesComprasCredito";
DROP TRIGGER IF EXISTS trg_after_update_periodo_recurrente ON "PeriodosRecurrentes";
DROP TRIGGER IF EXISTS trg_after_insert_aporte_detalle_origen ON "AportesDetalle";
DROP FUNCTION IF EXISTS fn_set_periodo_facturacion_cuota();
DROP FUNCTION IF EXISTS fn_sync_update_cuota_detalle_subledger();
DROP FUNCTION IF EXISTS fn_actualizar_saldo_cuenta();
DROP FUNCTION IF EXISTS fn_sync_prestamo_to_subledger();
DROP FUNCTION IF EXISTS fn_imputar_cuotas_tc_responsable();
DROP FUNCTION IF EXISTS fn_imputar_gasto_recurrente_compartido();
DROP FUNCTION IF EXISTS fn_vincular_origen_cruce_aporte();
DROP FUNCTION IF EXISTS sp_actualizar_trm_compra_usd(int8, numeric, bool);
DROP FUNCTION IF EXISTS sp_pagar_extracto_tarjeta(int8, int8, int8, char, numeric);
DROP FUNCTION IF EXISTS sp_registrar_abono_persona(int8, int8, int8, numeric, char, varchar, int8);

-- ─── 001: Triggers 3 y 5 → definiciones antiguas ───
CREATE OR REPLACE FUNCTION public.fn_auto_cruce_aporte_tercero()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_fecha_dia date;
  v_owner_id int8;
  v_responsable_obligacion_id int8;
  v_mi_persona_id int8;
  v_corte_activo_id int8;
  v_nuevo_prestamo_id int8;
BEGIN
  SELECT d.fecha, o.owner_user_id, o.responsable_principal_id
    INTO v_fecha_dia, v_owner_id, v_responsable_obligacion_id
  FROM "AportesDia" d
  JOIN "ObligacionesMes" o ON o.id = d.obligacion_mes_id
  WHERE d.id = NEW.aporte_dia_id;

  SELECT id INTO v_mi_persona_id
  FROM "Personas"
  WHERE legacy_appsheet_id = 'lm1R40P16oHgkM3Szu91du' OR linked_user_id = v_owner_id
  LIMIT 1;

  -- Si el aporte se anota a nombre de Andrés, Alicia o Jeimmy (ni es Papá ni eres tú):
  IF NEW.persona_id <> v_responsable_obligacion_id
     AND (v_mi_persona_id IS NULL OR NEW.persona_id <> v_mi_persona_id)
     AND NEW.prestamo_cruce_generado_id IS NULL THEN

    SELECT id INTO v_corte_activo_id
    FROM "CortesCobro"
    WHERE v_fecha_dia BETWEEN fecha_inicio AND fecha_final
    ORDER BY fecha_inicio DESC LIMIT 1;

    INSERT INTO "Prestamos" (
      owner_user_id, responsable, fecha_prestamo, valor_prestado, concepto,
      comentarios, estado, metodo, corte_id, creado_por_persona_id, origen_cruce_aporte_id
    ) VALUES (
      v_owner_id, NEW.persona_id, v_fecha_dia, NEW.valor,
      'Cruce Aporte Carro (' || NEW.metodo || ')',
      COALESCE(NEW.comentarios, 'Cruce automático desde aporte diario'),
      'Pendiente', 'Pago Fernando', v_corte_activo_id, v_mi_persona_id, NEW.id
    ) RETURNING id INTO v_nuevo_prestamo_id;

    NEW.prestamo_cruce_generado_id := v_nuevo_prestamo_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_procesar_cruce_deuda()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- 1. Abono a favor de quien entrega el cruce (Ej: Tu Papá reduce su saldo pendiente del Carro)
  INSERT INTO "MovimientosDeudaPersona" (
    owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
    tipo_movimiento, signo, monto, prestamo_id, periodo_recurrente_id, cruce_deuda_id, concepto
  ) VALUES (
    NEW.owner_user_id, NEW.persona_que_abona_id, NEW.fecha_cruce, to_char(NEW.fecha_cruce, 'YYYY-MM'),
    'ABONO_CRUCE_DEUDA', -1, NEW.monto, NEW.prestamo_destino_id, NEW.periodo_recurrente_destino_id, NEW.id,
    'Abono por cruce (asume persona ID ' || NEW.persona_que_asume_deuda_id || '): ' || NEW.concepto
  );

  -- 2. Cargo en contra de quien ahora te debe la plata (Ej: Andrés)
  INSERT INTO "MovimientosDeudaPersona" (
    owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
    tipo_movimiento, signo, monto, prestamo_id, cruce_deuda_id, concepto
  ) VALUES (
    NEW.owner_user_id, NEW.persona_que_asume_deuda_id, NEW.fecha_cruce, to_char(NEW.fecha_cruce, 'YYYY-MM'),
    'CARGO_CRUCE_DEUDA', 1, NEW.monto, NEW.prestamo_destino_id, NEW.id,
    'Deuda asumida por cruce de persona ID ' || NEW.persona_que_abona_id || ': ' || NEW.concepto
  );

  RETURN NEW;
END;
$function$;

-- ─── 001: vistas ───
DROP VIEW IF EXISTS "vw_AportesDiaResumen";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'vw_ResumenObligacionesMes_legacy') THEN
    DROP VIEW IF EXISTS "vw_ResumenObligacionesMes";
    ALTER VIEW "vw_ResumenObligacionesMes_legacy" RENAME TO "vw_ResumenObligacionesMes";
  END IF;
END $$;

-- Los índices idx_* de 001 son inocuos y se conservan.
COMMIT;
