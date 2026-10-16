-- =============================================================================
-- 007 · Semilla idempotente de los 13 productos financieros históricos (ago-2021 → oct-2026)
-- =============================================================================
-- IDEMPOTENTE y ADITIVA: solo crea lo que falta y solo rellena campos que están en NULL; nunca borra ni pisa lo que ya existe.
-- Re-ejecutarla no duplica nada. Se aplica después de 006 con `node scripts/aplicar-sql.js`.
--
--  9 tarjetas usadas en compras (6 de crédito, 3 de débito):
--     crédito  *1927 (activa) · *9587 · *0088 → línea American Express
--              *9491 (activa) · *7293 · *5052 → línea Mastercard
--     débito   *4278 → *8949 → *7992 (activa) → línea «Débito» de la cuenta *3698 (la principal)
--  4 cuentas/orígenes para el resto de movimientos:
--     cuenta *3698 · cuenta *4248 · «Cuenta de ahorros (sin número)» · «Tarjeta de crédito (sin número)»
--
-- Lo que NO se puede saber desde los datos se deja ajustable en la pantalla de tarjetas (a qué línea pertenece un plástico histórico,
-- a qué cuenta pertenece una tarjeta de débito). Los plásticos sembrados llevan una nota que lo dice.
-- Sin ningún dato de usuario (BD vacía) no hace nada.
-- =============================================================================

DO $$
DECLARE
  v_owner     int8;
  v_c3698     int8;
  v_c4248     int8;
  v_linea     int8;
  v_plastico  int8;
  v_prev      int8;
  v_hay_activo boolean;
  v_seq       text;
  v_max       int8;
  v_sig       int8;
  r           record;
  v_marca CONSTANT text := 'Sembrado por el plan V2 (fase 2). Revisa a qué tarjeta/cuenta pertenece si no coincide.';
BEGIN
  SELECT owner_user_id INTO v_owner FROM "Tarjetas" WHERE owner_user_id IS NOT NULL ORDER BY id LIMIT 1;
  IF v_owner IS NULL THEN
    SELECT owner_user_id INTO v_owner FROM "CuentasFinancieras" ORDER BY id LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN
    RAISE NOTICE '007: no hay datos de usuario; no se siembra nada.';
    RETURN;
  END IF;

  -- Las secuencias de id pueden haber quedado detrás de los ids que ya existen (filas insertadas con id explícito): se adelantan y
  -- nunca se retroceden. Sin esto, el primer INSERT chocaría con una fila existente.
  FOR r IN SELECT * FROM (VALUES ('TarjetaPlasticos'), ('Tarjetas'), ('CuentasFinancieras')) AS t(tabla) LOOP
    v_seq := pg_get_serial_sequence(format('%I', r.tabla), 'id');
    EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM %I', r.tabla) INTO v_max;
    IF v_seq IS NOT NULL AND v_max > 0 THEN
      EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', v_seq) INTO v_sig;
      IF v_sig <= v_max THEN PERFORM setval(v_seq, v_max); END IF;
    END IF;
  END LOOP;

  -- ─── Cuentas: se reutilizan las que ya existen (por sus últimos 4) y solo se crean las que faltan ───
  SELECT id INTO v_c3698 FROM "CuentasFinancieras"
   WHERE owner_user_id = v_owner AND NOT es_generica AND ultimos_4_digitos ~ '(^|[^0-9])3698([^0-9]|$)' ORDER BY id LIMIT 1;
  IF v_c3698 IS NULL THEN
    INSERT INTO "CuentasFinancieras" (owner_user_id, nombre, tipo_cuenta, banco_entidad, ultimos_4_digitos, moneda, saldo_actual, is_active)
    VALUES (v_owner, 'Cuenta *3698', 'AHORROS', 'Bancolombia', '3698', 'COP', 0, true) RETURNING id INTO v_c3698;
  END IF;
  UPDATE "CuentasFinancieras" SET fecha_inicio_uso = COALESCE(fecha_inicio_uso, DATE '2021-08-09') WHERE id = v_c3698;

  SELECT id INTO v_c4248 FROM "CuentasFinancieras"
   WHERE owner_user_id = v_owner AND NOT es_generica AND ultimos_4_digitos ~ '(^|[^0-9])4248([^0-9]|$)' ORDER BY id LIMIT 1;
  IF v_c4248 IS NULL THEN
    INSERT INTO "CuentasFinancieras" (owner_user_id, nombre, tipo_cuenta, banco_entidad, ultimos_4_digitos, moneda, saldo_actual, is_active)
    VALUES (v_owner, 'Cuenta *4248', 'AHORROS', 'Bancolombia', '4248', 'COP', 0, true) RETURNING id INTO v_c4248;
  END IF;
  UPDATE "CuentasFinancieras" SET fecha_inicio_uso = COALESCE(fecha_inicio_uso, DATE '2026-09-17') WHERE id = v_c4248;

  IF NOT EXISTS (SELECT 1 FROM "CuentasFinancieras" WHERE owner_user_id = v_owner AND es_generica) THEN
    INSERT INTO "CuentasFinancieras" (owner_user_id, nombre, tipo_cuenta, banco_entidad, ultimos_4_digitos, moneda, saldo_actual, is_active, es_generica, fecha_inicio_uso, fecha_fin_uso)
    VALUES (v_owner, 'Cuenta de ahorros (sin número)', 'AHORROS', 'Bancolombia', NULL, 'COP', 0, false, true, DATE '2021-08-27', DATE '2026-07-22');
  END IF;

  -- ─── Tarjetas de crédito: plásticos de las líneas American Express y Mastercard ───
  FOR r IN
    SELECT * FROM (VALUES
      ('9587', '1927', 'American Express', DATE '2022-01-04', DATE '2024-03-16', false, NULL::text),
      ('0088', '1927', 'American Express', DATE '2024-03-20', DATE '2024-06-04', false, '9587'),
      ('1927', '1927', 'American Express', DATE '2024-12-27', NULL::date,        true,  '0088'),
      ('7293', '9491', 'Mastercard',       DATE '2022-08-25', DATE '2024-03-16', false, NULL::text),
      ('5052', '9491', 'Mastercard',       DATE '2024-03-30', DATE '2024-06-05', false, '7293'),
      ('9491', '9491', 'Mastercard',       DATE '2024-12-28', NULL::date,        true,  '5052')
    ) AS t(u4, ancla, franquicia, desde, hasta, activo, reemplaza)
  LOOP
    SELECT id INTO v_plastico FROM "TarjetaPlasticos" WHERE owner_user_id IS NOT DISTINCT FROM v_owner AND ultimos_4 = r.u4 ORDER BY id LIMIT 1;
    IF v_plastico IS NULL THEN
      -- La línea es la del plástico «ancla» (o la que lista esos dígitos); si no existe, se crea.
      SELECT tarjeta_id INTO v_linea FROM "TarjetaPlasticos" WHERE owner_user_id IS NOT DISTINCT FROM v_owner AND ultimos_4 = r.ancla ORDER BY id LIMIT 1;
      IF v_linea IS NULL THEN
        SELECT id INTO v_linea FROM "Tarjetas"
         WHERE owner_user_id = v_owner AND tipo_tarjeta = 'CREDITO' AND NOT es_generica AND ultimos_4_digitos ~ ('(^|[^0-9])' || r.ancla || '([^0-9]|$)') ORDER BY id LIMIT 1;
      END IF;
      IF v_linea IS NULL THEN
        INSERT INTO "Tarjetas" (owner_user_id, franquicia, tipo_tarjeta) VALUES (v_owner, r.franquicia, 'CREDITO') RETURNING id INTO v_linea;
      END IF;
      SELECT EXISTS (SELECT 1 FROM "TarjetaPlasticos" WHERE tarjeta_id = v_linea AND es_activo) INTO v_hay_activo;
      INSERT INTO "TarjetaPlasticos" (tarjeta_id, owner_user_id, ultimos_4, es_activo, vigente_desde, vigente_hasta, notas)
      VALUES (v_linea, v_owner, r.u4, r.activo AND NOT v_hay_activo, r.desde, CASE WHEN r.activo AND NOT v_hay_activo THEN NULL ELSE r.hasta END, v_marca)
      RETURNING id INTO v_plastico;
      -- La lista de dígitos de la línea (la que lee el parser de correos) incluye todos sus plásticos, el activo primero.
      UPDATE "Tarjetas" t
         SET ultimos_4_digitos = (SELECT string_agg(ultimos_4, ',' ORDER BY es_activo DESC, id DESC) FROM "TarjetaPlasticos" WHERE tarjeta_id = t.id)
       WHERE t.id = v_linea;
    ELSE
      UPDATE "TarjetaPlasticos"
         SET vigente_desde = COALESCE(vigente_desde, r.desde),
             vigente_hasta = CASE WHEN es_activo THEN vigente_hasta ELSE COALESCE(vigente_hasta, r.hasta) END
       WHERE id = v_plastico;
    END IF;

    IF r.reemplaza IS NOT NULL THEN
      UPDATE "TarjetaPlasticos" p
         SET reemplaza_a_id = (SELECT x.id FROM "TarjetaPlasticos" x WHERE x.owner_user_id IS NOT DISTINCT FROM v_owner AND x.ultimos_4 = r.reemplaza ORDER BY x.id LIMIT 1)
       WHERE p.id = v_plastico AND p.reemplaza_a_id IS NULL;
    END IF;
  END LOOP;

  -- ─── Tarjeta de crédito «sin número» (avances de efectivo y avisos sin los últimos 4) ───
  IF NOT EXISTS (SELECT 1 FROM "Tarjetas" WHERE owner_user_id = v_owner AND es_generica AND tipo_tarjeta = 'CREDITO') THEN
    INSERT INTO "Tarjetas" (owner_user_id, franquicia, descripcion, alias, tipo_tarjeta, es_generica)
    VALUES (v_owner, 'Tarjeta de crédito', 'Sin número: avances de efectivo y avisos del banco que no traen los últimos 4 dígitos', 'Crédito (sin número)', 'CREDITO', true);
  END IF;

  -- ─── Tarjeta de débito de la cuenta principal *3698: *4278 → *8949 → *7992 ───
  SELECT id INTO v_linea FROM "Tarjetas" WHERE owner_user_id = v_owner AND tipo_tarjeta = 'DEBITO' AND cuenta_id = v_c3698 ORDER BY id LIMIT 1;
  IF v_linea IS NULL THEN
    INSERT INTO "Tarjetas" (owner_user_id, franquicia, descripcion, alias, tipo_tarjeta, cuenta_id)
    VALUES (v_owner, 'Débito', 'Tarjeta débito de la cuenta *3698', 'Débito *3698', 'DEBITO', v_c3698) RETURNING id INTO v_linea;
  END IF;

  v_prev := NULL;
  FOR r IN
    SELECT * FROM (VALUES
      ('4278', DATE '2021-11-26', DATE '2024-06-05', false),
      ('8949', DATE '2025-01-05', DATE '2025-03-10', false),
      ('7992', DATE '2026-09-19', NULL::date,        true)
    ) AS t(u4, desde, hasta, activo) ORDER BY desde
  LOOP
    SELECT id INTO v_plastico FROM "TarjetaPlasticos" WHERE owner_user_id IS NOT DISTINCT FROM v_owner AND ultimos_4 = r.u4 ORDER BY id LIMIT 1;
    IF v_plastico IS NULL THEN
      SELECT EXISTS (SELECT 1 FROM "TarjetaPlasticos" WHERE tarjeta_id = v_linea AND es_activo) INTO v_hay_activo;
      INSERT INTO "TarjetaPlasticos" (tarjeta_id, owner_user_id, ultimos_4, es_activo, vigente_desde, vigente_hasta, reemplaza_a_id, notas)
      VALUES (v_linea, v_owner, r.u4, r.activo AND NOT v_hay_activo, r.desde, CASE WHEN r.activo AND NOT v_hay_activo THEN NULL ELSE r.hasta END, v_prev, v_marca)
      RETURNING id INTO v_plastico;
    ELSE
      UPDATE "TarjetaPlasticos"
         SET vigente_desde = COALESCE(vigente_desde, r.desde),
             vigente_hasta = CASE WHEN es_activo THEN vigente_hasta ELSE COALESCE(vigente_hasta, r.hasta) END,
             reemplaza_a_id = COALESCE(reemplaza_a_id, v_prev)
       WHERE id = v_plastico;
    END IF;
    v_prev := v_plastico;
  END LOOP;
  UPDATE "Tarjetas" t
     SET ultimos_4_digitos = (SELECT string_agg(ultimos_4, ',' ORDER BY es_activo DESC, id DESC) FROM "TarjetaPlasticos" WHERE tarjeta_id = t.id)
   WHERE t.id = v_linea AND t.ultimos_4_digitos IS NULL;
END $$;
