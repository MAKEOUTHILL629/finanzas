-- =============================================================================
-- 001 · Objetos de base de datos de "base de datos-documentacion.md" (secciones 4, 8, 10 y 11)
-- =============================================================================
-- IDEMPOTENTE: se puede aplicar varias veces. NO modifica datos (solo DDL).
-- Se aplica con `node scripts/aplicar-sql.js` (una transacción; `--dry-run` hace ROLLBACK al final).
--
-- Diferencias deliberadas respecto al SQL del documento (todas por seguridad con lo que escribe la app Scala,
-- que NO informa `owner_user_id`, y con las restricciones reales de la BD):
--   * `MovimientosDeudaPersona` tiene `owner_user_id NOT NULL` y `CHECK (monto > 0)`: los triggers omiten las filas sin
--     dueño/responsable y los montos <= 0 en lugar de hacer fallar la escritura original.
--   * Trigger 4: un abono solo se registra si existe su cargo (evita saldos negativos con préstamos históricos aún no
--     cargados en el sub-ledger), no abona 0 (D17) y respeta `app.omitir_abono_prestamo` (lo activa
--     `sp_registrar_abono_persona` al liquidar un corte, para no abonar dos veces). Anular un préstamo anula sus asientos.
--   * Triggers 3 y 5: ya existían en la BD con otra definición (el 3 sin aprobaciones ni `saldo_pendiente`; el 5 sin
--     `estado`, de modo que los cruces nunca contaban en el saldo acumulado). Se alinean con el documento y se
--     conserva lo extra del real (`Prestamos.origen_cruce_aporte_id`, ahora enlazado por un trigger AFTER INSERT
--     porque la FK no admite escribirlo desde el BEFORE; y el concepto «Cruce Aporte Carro»).
--   * `vw_ResumenObligacionesMes`: la que existía era una versión antigua (sin `owner_user_id`); se conserva
--     renombrada como `vw_ResumenObligacionesMes_legacy`.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.1 Índices de rendimiento
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_compras_credito_owner_tarjeta ON "ComprasCredito" (owner_user_id, tarjeta, estado);
CREATE INDEX IF NOT EXISTS idx_cuotas_detalle_periodo_estado ON "CuotasDetalle" (periodo_facturacion, estado, compra);
CREATE INDEX IF NOT EXISTS idx_resp_compras_persona ON "ResponsablesComprasCredito" (persona, compra_credito);
CREATE INDEX IF NOT EXISTS idx_transacciones_owner_fecha ON "Transacciones" (owner_user_id, fecha_transaccion DESC, tipo_transaccion);
CREATE INDEX IF NOT EXISTS idx_notificaciones_estado ON "NotificacionesCorreo" (owner_user_id, estado_procesamiento);
CREATE INDEX IF NOT EXISTS idx_periodos_rec_owner_periodo ON "PeriodosRecurrentes" (owner_user_id, periodo, estado);
CREATE INDEX IF NOT EXISTS idx_prestamos_owner_resp_estado ON "Prestamos" (owner_user_id, responsable, estado, corte_id);
CREATE INDEX IF NOT EXISTS idx_obligaciones_mes_periodo ON "ObligacionesMes" (owner_user_id, tipo_obligacion, periodo);
CREATE INDEX IF NOT EXISTS idx_aportes_dia_obligacion_fecha ON "AportesDia" (obligacion_mes_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_aportes_detalle_dia_persona ON "AportesDetalle" (aporte_dia_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_mov_deuda_ledger ON "MovimientosDeudaPersona" (owner_user_id, persona_id, periodo_imputacion, estado);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.2 Vistas calculadas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'vw_ResumenObligacionesMes')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vw_ResumenObligacionesMes' AND column_name = 'owner_user_id'
     ) THEN
    ALTER VIEW "vw_ResumenObligacionesMes" RENAME TO "vw_ResumenObligacionesMes_legacy";
  END IF;
END $$;

CREATE OR REPLACE VIEW "vw_ResumenObligacionesMes" AS
SELECT
  o.id AS obligacion_mes_id,
  o.owner_user_id,
  o.tipo_obligacion,
  o.responsable_principal_id,
  p_resp.nombre AS responsable_principal_nombre,
  o.concepto,
  o.periodo,
  o.meta_mensual,
  o.fecha_inicio,
  o.fecha_final,
  CASE
    WHEN COALESCE(SUM(ad.valor), 0) >= o.meta_mensual THEN 'COMPLETADO'
    ELSE 'ABIERTO'
  END AS estado_calculado,
  COUNT(DISTINCT d.id) AS dias_aportados,
  COUNT(ad.id) AS cantidad_registros,
  COALESCE(SUM(ad.valor), 0)::numeric(15,2) AS aporte_total_real,
  (o.meta_mensual - COALESCE(SUM(ad.valor), 0))::numeric(15,2) AS restante_real,
  COALESCE(SUM(CASE WHEN ad.persona_id = o.responsable_principal_id THEN ad.valor ELSE 0 END), 0)::numeric(15,2) AS aportado_directo_responsable,
  COALESCE(SUM(CASE WHEN ad.persona_id <> o.responsable_principal_id THEN ad.valor ELSE 0 END), 0)::numeric(15,2) AS aportado_por_cruces
FROM "ObligacionesMes" o
JOIN "Personas" p_resp ON p_resp.id = o.responsable_principal_id
LEFT JOIN "AportesDia" d ON d.obligacion_mes_id = o.id
LEFT JOIN "AportesDetalle" ad ON ad.aporte_dia_id = d.id
GROUP BY o.id, p_resp.nombre;

CREATE OR REPLACE VIEW "vw_AportesDiaResumen" AS
SELECT
  d.id AS aporte_dia_id,
  d.obligacion_mes_id,
  o.concepto AS mes_concepto,
  o.periodo,
  d.fecha,
  d.notas,
  COUNT(ad.id) AS items_count,
  COALESCE(SUM(ad.valor), 0)::numeric(15,2) AS valor_total_dia
FROM "AportesDia" d
JOIN "ObligacionesMes" o ON o.id = d.obligacion_mes_id
LEFT JOIN "AportesDetalle" ad ON ad.aporte_dia_id = d.id
GROUP BY d.id, o.concepto, o.periodo;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 1: periodo_facturacion ('YYYY-MM') de CuotasDetalle cuando llega NULL
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_set_periodo_facturacion_cuota()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.periodo_facturacion IS NULL AND NEW.fecha_pago IS NOT NULL THEN
    NEW.periodo_facturacion := to_char(NEW.fecha_pago, 'YYYY-MM');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_periodo_cuota ON "CuotasDetalle";
CREATE TRIGGER trg_set_periodo_cuota
BEFORE INSERT OR UPDATE ON "CuotasDetalle"
FOR EACH ROW EXECUTE FUNCTION fn_set_periodo_facturacion_cuota();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 2: saldo_actual de CuentasFinancieras al insertar/actualizar/borrar una Transacción CONFIRMADA
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_actualizar_saldo_cuenta()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.estado = 'CONFIRMADO' THEN
    IF OLD.cuenta_origen_id IS NOT NULL THEN
      UPDATE "CuentasFinancieras" SET saldo_actual = saldo_actual + OLD.monto_cop WHERE id = OLD.cuenta_origen_id;
    END IF;
    IF OLD.cuenta_destino_id IS NOT NULL THEN
      UPDATE "CuentasFinancieras" SET saldo_actual = saldo_actual - OLD.monto_cop WHERE id = OLD.cuenta_destino_id;
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.estado = 'CONFIRMADO' THEN
    IF NEW.cuenta_origen_id IS NOT NULL THEN
      UPDATE "CuentasFinancieras" SET saldo_actual = saldo_actual - NEW.monto_cop WHERE id = NEW.cuenta_origen_id;
    END IF;
    IF NEW.cuenta_destino_id IS NOT NULL THEN
      UPDATE "CuentasFinancieras" SET saldo_actual = saldo_actual + NEW.monto_cop WHERE id = NEW.cuenta_destino_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_actualizar_saldo_cuenta ON "Transacciones";
CREATE TRIGGER trg_actualizar_saldo_cuenta
AFTER INSERT OR UPDATE OR DELETE ON "Transacciones"
FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cuenta();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 3: AportesDetalle a nombre de un tercero → Préstamo por cruce + 2 aprobaciones
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_auto_cruce_aporte_tercero()
RETURNS TRIGGER AS $$
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
  WHERE linked_user_id = v_owner_id OR legacy_appsheet_id = 'lm1R40P16oHgkM3Szu91du'
  ORDER BY id LIMIT 1;

  -- Si la persona del aporte no es el responsable de la meta (Papá) ni eres tú mismo:
  IF NEW.persona_id <> v_responsable_obligacion_id
     AND (v_mi_persona_id IS NULL OR NEW.persona_id <> v_mi_persona_id)
     AND NEW.prestamo_cruce_generado_id IS NULL THEN

    SELECT id INTO v_corte_activo_id
    FROM "CortesCobro"
    WHERE owner_user_id = v_owner_id
      AND v_fecha_dia BETWEEN fecha_inicio AND fecha_final
    ORDER BY fecha_inicio DESC LIMIT 1;

    INSERT INTO "Prestamos" (
      owner_user_id, responsable, fecha_prestamo, valor_prestado, saldo_pendiente,
      direccion_prestamo, concepto, comentarios, estado, metodo, corte_id, creado_por_persona_id
    ) VALUES (
      v_owner_id, NEW.persona_id, v_fecha_dia, NEW.valor, NEW.valor,
      'POR_COBRAR', 'Cruce Aporte Carro (' || NEW.metodo || ')',
      COALESCE(NEW.comentarios, 'Cruce generado desde aporte diario'),
      'Pendiente', 'Pago Fernando', v_corte_activo_id, v_mi_persona_id
    ) RETURNING id INTO v_nuevo_prestamo_id;

    NEW.prestamo_cruce_generado_id := v_nuevo_prestamo_id;

    -- Aprobaciones: el deudor (pendiente) y el administrador (aprobada automáticamente)
    INSERT INTO "AprobacionesPrestamos" (prestamo_id, persona_id, estado, comentarios, fecha_aprobacion)
    VALUES (v_nuevo_prestamo_id, NEW.persona_id, 'Pendiente', 'Generada automáticamente por cruce', NULL);

    IF v_mi_persona_id IS NOT NULL THEN
      INSERT INTO "AprobacionesPrestamos" (prestamo_id, persona_id, estado, comentarios, fecha_aprobacion)
      VALUES (v_nuevo_prestamo_id, v_mi_persona_id, 'Aprobado', 'Aprobación automática creador', now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_before_insert_aporte_detalle ON "AportesDetalle";
CREATE TRIGGER trg_before_insert_aporte_detalle
BEFORE INSERT ON "AportesDetalle"
FOR EACH ROW EXECUTE FUNCTION fn_auto_cruce_aporte_tercero();

-- El BEFORE INSERT no puede escribir Prestamos.origen_cruce_aporte_id (FK al aporte, que todavía no existe):
-- este AFTER INSERT enlaza el préstamo con el aporte que lo originó.
CREATE OR REPLACE FUNCTION fn_vincular_origen_cruce_aporte()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.prestamo_cruce_generado_id IS NOT NULL THEN
    UPDATE "Prestamos"
    SET origen_cruce_aporte_id = NEW.id
    WHERE id = NEW.prestamo_cruce_generado_id
      AND origen_cruce_aporte_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_after_insert_aporte_detalle_origen ON "AportesDetalle";
CREATE TRIGGER trg_after_insert_aporte_detalle_origen
AFTER INSERT ON "AportesDetalle"
FOR EACH ROW EXECUTE FUNCTION fn_vincular_origen_cruce_aporte();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 4: Prestamos → sub-ledger MovimientosDeudaPersona
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_sync_prestamo_to_subledger()
RETURNS TRIGGER AS $$
DECLARE
  v_monto_abono numeric;
BEGIN
  -- Filas sin dueño o sin responsable (las escribe la app Scala) no tienen sub-ledger.
  IF NEW.owner_user_id IS NULL OR NEW.responsable IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.valor_prestado, 0) > 0 THEN
      INSERT INTO "MovimientosDeudaPersona" (
        owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
        tipo_movimiento, signo, monto, prestamo_id, concepto, estado
      ) VALUES (
        NEW.owner_user_id,
        NEW.responsable,
        COALESCE(NEW.fecha_prestamo, CURRENT_DATE),
        to_char(COALESCE(NEW.fecha_cobro, NEW.fecha_prestamo, CURRENT_DATE), 'YYYY-MM'),
        CASE WHEN NEW.metodo IN ('Pago Fernando', 'Prestamo Fernando') THEN 'CARGO_CRUCE_DEUDA' ELSE 'CARGO_PRESTAMO_DIRECTO' END,
        1,
        NEW.valor_prestado,
        NEW.id,
        COALESCE(NEW.concepto, 'Préstamo registrado'),
        'CONFIRMADO'
      );

      -- Si nació ya en estado 'Pagado' (ej. migración histórica), insertar su contra-asiento de abono
      IF LOWER(COALESCE(NEW.estado, '')) = 'pagado' THEN
        INSERT INTO "MovimientosDeudaPersona" (
          owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
          tipo_movimiento, signo, monto, prestamo_id, concepto, estado
        ) VALUES (
          NEW.owner_user_id,
          NEW.responsable,
          COALESCE(NEW.fecha_cobro, NEW.fecha_prestamo, CURRENT_DATE),
          to_char(COALESCE(NEW.fecha_cobro, NEW.fecha_prestamo, CURRENT_DATE), 'YYYY-MM'),
          'ABONO_PAGO_RECIBIDO',
          -1,
          NEW.valor_prestado,
          NEW.id,
          'Pago de préstamo: ' || COALESCE(NEW.concepto, ''),
          'CONFIRMADO'
        );
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF LOWER(COALESCE(OLD.estado, '')) <> 'pagado' AND LOWER(COALESCE(NEW.estado, '')) = 'pagado' THEN
      v_monto_abono := COALESCE(NEW.saldo_pendiente, NEW.valor_prestado, 0);
      -- Solo si el cargo existe en el sub-ledger, el monto es positivo y el abono no lo registra otro proceso
      -- (sp_registrar_abono_persona ya anotó el pago de la persona).
      IF v_monto_abono > 0
         AND COALESCE(current_setting('app.omitir_abono_prestamo', true), '') <> 'on'
         AND EXISTS (
           SELECT 1 FROM "MovimientosDeudaPersona"
           WHERE prestamo_id = NEW.id AND signo = 1 AND COALESCE(estado, 'CONFIRMADO') <> 'ANULADO'
         ) THEN
        INSERT INTO "MovimientosDeudaPersona" (
          owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
          tipo_movimiento, signo, monto, prestamo_id, concepto, estado
        ) VALUES (
          NEW.owner_user_id,
          NEW.responsable,
          CURRENT_DATE,
          to_char(CURRENT_DATE, 'YYYY-MM'),
          'ABONO_PAGO_RECIBIDO',
          -1,
          v_monto_abono,
          NEW.id,
          'Liquidación de préstamo: ' || COALESCE(NEW.concepto, ''),
          'CONFIRMADO'
        );
      END IF;

    ELSIF LOWER(COALESCE(OLD.estado, '')) <> 'anulado' AND LOWER(COALESCE(NEW.estado, '')) = 'anulado' THEN
      -- Anular el préstamo anula sus asientos propios (los de un CrucesDeuda se anulan desde el cruce)
      UPDATE "MovimientosDeudaPersona"
      SET estado = 'ANULADO'
      WHERE prestamo_id = NEW.id
        AND cruce_deuda_id IS NULL
        AND COALESCE(estado, 'CONFIRMADO') <> 'ANULADO';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_prestamo_subledger ON "Prestamos";
CREATE TRIGGER trg_sync_prestamo_subledger
AFTER INSERT OR UPDATE ON "Prestamos"
FOR EACH ROW EXECUTE FUNCTION fn_sync_prestamo_to_subledger();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 5: CrucesDeuda → par contable (-1 a quien cede, +1 a quien asume)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_procesar_cruce_deuda()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "MovimientosDeudaPersona" (
    owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
    tipo_movimiento, signo, monto, prestamo_id, periodo_recurrente_id, cruce_deuda_id, concepto, estado
  ) VALUES (
    NEW.owner_user_id, NEW.persona_que_abona_id, NEW.fecha_cruce,
    to_char(NEW.fecha_cruce, 'YYYY-MM'),
    'ABONO_CRUCE_DEUDA', -1, NEW.monto, NEW.prestamo_destino_id,
    NEW.periodo_recurrente_destino_id, NEW.id,
    'Abono por cruce: ' || NEW.concepto, 'CONFIRMADO'
  );

  INSERT INTO "MovimientosDeudaPersona" (
    owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
    tipo_movimiento, signo, monto, prestamo_id, cruce_deuda_id, concepto, estado
  ) VALUES (
    NEW.owner_user_id, NEW.persona_que_asume_deuda_id, NEW.fecha_cruce,
    to_char(NEW.fecha_cruce, 'YYYY-MM'),
    'CARGO_CRUCE_DEUDA', 1, NEW.monto, NEW.prestamo_destino_id, NEW.id,
    'Deuda asumida por cruce: ' || NEW.concepto, 'CONFIRMADO'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_after_insert_cruce_deuda ON "CrucesDeuda";
CREATE TRIGGER trg_after_insert_cruce_deuda
AFTER INSERT ON "CrucesDeuda"
FOR EACH ROW EXECUTE FUNCTION fn_procesar_cruce_deuda();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 6: Responsable de una compra con tarjeta → cargos por cuota en el sub-ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_imputar_cuotas_tc_responsable()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_id int8;
  v_mi_persona_id int8;
  v_concepto_compra varchar;
  v_num_cuotas int2;
BEGIN
  SELECT owner_user_id, concepto, numero_cuotas
    INTO v_owner_id, v_concepto_compra, v_num_cuotas
  FROM "ComprasCredito"
  WHERE id = NEW.compra_credito;

  -- Compras sin dueño (las escribe la app Scala): sin sub-ledger.
  IF v_owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_mi_persona_id
  FROM "Personas"
  WHERE linked_user_id = v_owner_id OR legacy_appsheet_id = 'lm1R40P16oHgkM3Szu91du'
  ORDER BY id LIMIT 1;

  -- Solo genera deuda si el responsable es un TERCERO (no tú mismo)
  IF NEW.persona IS NOT NULL AND (v_mi_persona_id IS NULL OR NEW.persona <> v_mi_persona_id) THEN
    INSERT INTO "MovimientosDeudaPersona" (
      owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
      tipo_movimiento, signo, monto, cuota_detalle_id, responsable_compra_id,
      appsheet_row_id, concepto, estado
    )
    SELECT
      v_owner_id,
      NEW.persona,
      cd.fecha_pago,
      COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')),
      'CARGO_CUOTA_TC',
      1,
      ROUND((cd.pago_total * (NEW.porcentaje_pago / 100.0))::numeric, 2),
      cd.id,
      NEW.id,
      'TC_CUOTA_' || cd.id || '_RESP_' || NEW.id,
      'Cuota ' || cd.numero_cuota || '/' || COALESCE(v_num_cuotas, 1) || ' - ' || COALESCE(v_concepto_compra, 'Compra TC'),
      CASE
        WHEN cd.numero_cuota = 1 OR COALESCE(cd.periodo_facturacion, to_char(cd.fecha_pago, 'YYYY-MM')) <= to_char(CURRENT_DATE, 'YYYY-MM')
        THEN 'CONFIRMADO'
        ELSE 'PROYECTADO'
      END
    FROM "CuotasDetalle" cd
    WHERE cd.compra = NEW.compra_credito
      AND cd.fecha_pago IS NOT NULL
      AND (NEW.cantidad_cuotas IS NULL OR cd.numero_cuota <= NEW.cantidad_cuotas)
      AND ROUND((cd.pago_total * (NEW.porcentaje_pago / 100.0))::numeric, 2) > 0
    ON CONFLICT (appsheet_row_id) DO UPDATE
      SET monto = EXCLUDED.monto,
          estado = EXCLUDED.estado;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_after_insert_responsable_tc ON "ResponsablesComprasCredito";
CREATE TRIGGER trg_after_insert_responsable_tc
AFTER INSERT OR UPDATE ON "ResponsablesComprasCredito"
FOR EACH ROW EXECUTE FUNCTION fn_imputar_cuotas_tc_responsable();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 7: PeriodoRecurrente FACTURADO/PAGADO → cargo a cada participante
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_imputar_gasto_recurrente_compartido()
RETURNS TRIGGER AS $$
DECLARE
  v_nombre_plantilla varchar;
  v_mi_persona_id int8;
  v_base_calculo numeric(15,2);
BEGIN
  IF NEW.estado IN ('FACTURADO', 'PAGADO') THEN
    SELECT nombre INTO v_nombre_plantilla
    FROM "PlantillasRecurrentes"
    WHERE id = NEW.plantilla_recurrente_id;

    SELECT id INTO v_mi_persona_id
    FROM "Personas"
    WHERE linked_user_id = NEW.owner_user_id OR legacy_appsheet_id = 'lm1R40P16oHgkM3Szu91du'
    ORDER BY id LIMIT 1;

    v_base_calculo := COALESCE(NEW.monto_real_pagado, NEW.monto_pronosticado);

    INSERT INTO "MovimientosDeudaPersona" (
      owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
      tipo_movimiento, signo, monto, periodo_recurrente_id,
      appsheet_row_id, concepto, estado
    )
    SELECT
      t.owner_user_id, t.persona_id, t.fecha_movimiento, t.periodo, 'CARGO_GASTO_COMPARTIDO', 1, t.monto,
      t.periodo_recurrente_id, t.appsheet_row_id, t.concepto, 'CONFIRMADO'
    FROM (
      SELECT
        NEW.owner_user_id AS owner_user_id,
        rr.persona_id AS persona_id,
        COALESCE(NEW.fecha_estimada_pago, CURRENT_DATE) AS fecha_movimiento,
        NEW.periodo AS periodo,
        COALESCE(
          rr.monto_fijo_participacion,
          ROUND((v_base_calculo * (rr.porcentaje_participacion / 100.0))::numeric, 2)
        ) AS monto,
        NEW.id AS periodo_recurrente_id,
        'REC_PER_' || NEW.id || '_PERS_' || rr.persona_id AS appsheet_row_id,
        'Gasto compartido: ' || v_nombre_plantilla || ' (' || NEW.periodo || ')' AS concepto
      FROM "ResponsablesRecurrentes" rr
      WHERE rr.plantilla_recurrente_id = NEW.plantilla_recurrente_id
        AND rr.persona_id IS NOT NULL
        AND (v_mi_persona_id IS NULL OR rr.persona_id <> v_mi_persona_id)
    ) t
    WHERE t.monto > 0
    ON CONFLICT (appsheet_row_id) DO UPDATE
      SET monto = EXCLUDED.monto,
          estado = 'CONFIRMADO';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_after_update_periodo_recurrente ON "PeriodosRecurrentes";
CREATE TRIGGER trg_after_update_periodo_recurrente
AFTER INSERT OR UPDATE ON "PeriodosRecurrentes"
FOR EACH ROW EXECUTE FUNCTION fn_imputar_gasto_recurrente_compartido();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 8: cambios de TRM/estado en CuotasDetalle → asientos del sub-ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_sync_update_cuota_detalle_subledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pago_total IS DISTINCT FROM OLD.pago_total OR NEW.estado IS DISTINCT FROM OLD.estado THEN
    UPDATE "MovimientosDeudaPersona" m
    SET
      monto = CASE
        WHEN ROUND((NEW.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2) > 0
        THEN ROUND((NEW.pago_total * (rcc.porcentaje_pago / 100.0))::numeric, 2)
        ELSE m.monto
      END,
      estado = CASE
        WHEN UPPER(COALESCE(NEW.estado, '')) IN ('FACTURADA', 'PAGADA') THEN 'CONFIRMADO'
        ELSE m.estado
      END
    FROM "ResponsablesComprasCredito" rcc
    WHERE m.cuota_detalle_id = NEW.id
      AND m.responsable_compra_id = rcc.id
      AND COALESCE(m.estado, 'CONFIRMADO') <> 'ANULADO';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_update_cuota_subledger ON "CuotasDetalle";
CREATE TRIGGER trg_sync_update_cuota_subledger
AFTER UPDATE ON "CuotasDetalle"
FOR EACH ROW EXECUTE FUNCTION fn_sync_update_cuota_detalle_subledger();

-- ─────────────────────────────────────────────────────────────────────────────
-- Sección 10: confirmar la TRM de una compra en dólares
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sp_actualizar_trm_compra_usd(
  p_compra_id int8,
  p_nueva_trm numeric(12,4),
  p_confirmar_definitivo bool DEFAULT true
) RETURNS void AS $$
DECLARE
  v_factor numeric(18,8);
BEGIN
  SELECT (p_nueva_trm / NULLIF(tasa_cambio_aplicada, 0))
    INTO v_factor
  FROM "ComprasCredito"
  WHERE id = p_compra_id AND moneda_original <> 'COP';

  IF v_factor IS NOT NULL AND v_factor > 0 THEN
    UPDATE "ComprasCredito"
    SET
      tasa_cambio_aplicada = p_nueva_trm,
      valor_compra = ROUND((valor_moneda_original * p_nueva_trm)::numeric, 2),
      pago_mensual = ROUND((pago_mensual * v_factor)::numeric, 2),
      trm_confirmada = p_confirmar_definitivo
    WHERE id = p_compra_id;

    -- El Trigger 8 actualiza MovimientosDeudaPersona
    UPDATE "CuotasDetalle"
    SET
      aporte_capital = ROUND((aporte_capital * v_factor)::numeric, 2),
      interes_pagado = ROUND((interes_pagado * v_factor)::numeric, 2),
      pago_total = ROUND((pago_total * v_factor)::numeric, 2),
      saldo_restante = ROUND((saldo_restante * v_factor)::numeric, 2)
    WHERE compra = p_compra_id
      AND UPPER(COALESCE(estado, '')) <> 'PAGADA';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sección 11.2: pago del extracto de una tarjeta
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sp_pagar_extracto_tarjeta(
  p_owner_user_id int8,
  p_tarjeta_id int8,
  p_cuenta_origen_id int8,
  p_periodo char(7),
  p_monto_pagado numeric(15,2)
) RETURNS int8 AS $$
DECLARE
  v_transaccion_id int8;
  v_nombre_tarjeta varchar;
BEGIN
  SELECT COALESCE(franquicia || ' - ' || descripcion, 'Tarjeta ID ' || id)
    INTO v_nombre_tarjeta
  FROM "Tarjetas" WHERE id = p_tarjeta_id;

  INSERT INTO "Transacciones" (
    owner_user_id, tipo_transaccion, cuenta_origen_id, tarjeta_pagada_id,
    fecha_transaccion, concepto, moneda_original, monto_original, tasa_cambio, monto_cop,
    origen_registro, estado
  ) VALUES (
    p_owner_user_id, 'PAGO_TARJETA', p_cuenta_origen_id, p_tarjeta_id,
    now(), 'Pago extracto ' || v_nombre_tarjeta || ' (' || p_periodo || ')',
    'COP', p_monto_pagado, 1.0000, p_monto_pagado, 'MANUAL', 'CONFIRMADO'
  ) RETURNING id INTO v_transaccion_id;

  UPDATE "CuotasDetalle" cd
  SET estado = 'PAGADA'
  FROM "ComprasCredito" cc
  WHERE cd.compra = cc.id
    AND cc.tarjeta = p_tarjeta_id
    AND cd.periodo_facturacion = p_periodo;

  RETURN v_transaccion_id;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sección 11.3: pago / reembolso recibido de una persona
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sp_registrar_abono_persona(
  p_owner_user_id int8,
  p_persona_id int8,
  p_cuenta_destino_id int8,
  p_monto numeric(15,2),
  p_periodo_imputacion char(7),
  p_concepto varchar,
  p_liquidar_prestamos_corte_id int8 DEFAULT NULL
) RETURNS int8 AS $$
DECLARE
  v_transaccion_id int8;
  v_movimiento_id int8;
BEGIN
  INSERT INTO "Transacciones" (
    owner_user_id, tipo_transaccion, cuenta_destino_id, fecha_transaccion,
    concepto, moneda_original, monto_original, tasa_cambio, monto_cop,
    origen_registro, estado
  ) VALUES (
    p_owner_user_id, 'REEMBOLSO_TERCERO', p_cuenta_destino_id, now(),
    p_concepto, 'COP', p_monto, 1.0000, p_monto, 'MANUAL', 'CONFIRMADO'
  ) RETURNING id INTO v_transaccion_id;

  INSERT INTO "MovimientosDeudaPersona" (
    owner_user_id, persona_id, fecha_movimiento, periodo_imputacion,
    tipo_movimiento, signo, monto, transaccion_id, concepto, estado
  ) VALUES (
    p_owner_user_id, p_persona_id, CURRENT_DATE, p_periodo_imputacion,
    'ABONO_PAGO_RECIBIDO', -1, p_monto, v_transaccion_id, p_concepto, 'CONFIRMADO'
  ) RETURNING id INTO v_movimiento_id;

  IF p_liquidar_prestamos_corte_id IS NOT NULL THEN
    -- El abono de la persona ya quedó anotado arriba: el Trigger 4 no debe abonar de nuevo cada préstamo.
    PERFORM set_config('app.omitir_abono_prestamo', 'on', true);
    UPDATE "Prestamos"
    SET estado = 'Pagado', saldo_pendiente = 0
    WHERE owner_user_id = p_owner_user_id
      AND responsable = p_persona_id
      AND corte_id = p_liquidar_prestamos_corte_id
      AND estado = 'Pendiente';
    PERFORM set_config('app.omitir_abono_prestamo', 'off', true);
  END IF;

  RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;
