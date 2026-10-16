-- =============================================================================
-- 008 · La lista de últimos 4 de cada tarjeta incluye TODOS sus plásticos
-- =============================================================================
-- IDEMPOTENTE y ADITIVA: solo AGREGA al final de `Tarjetas.ultimos_4_digitos` los dígitos de los plásticos que faltaban; no quita ni
-- reordena nada de lo que ya estaba. Re-ejecutarla no cambia nada.
--
-- Por qué: el parser de correos identifica la tarjeta de un aviso por esa lista (no por la tabla de plásticos). Un plástico que se
-- registró por otra vía (p. ej. el *0088 de la American Express) quedaba fuera, el correo seguía «sin tarjeta» y aceptar la sugerencia
-- no tenía efecto. La aplicación también la mantiene al día desde ahora (`asegurarPlastico` sincroniza aunque el plástico ya exista).
--
-- Prudencia: un dígito que YA identifica a otra tarjeta o a una cuenta del mismo dueño NO se agrega (quedaría ambiguo: el correo no
-- sabría a cuál asignarlo). Esos casos se resuelven a mano desde la pantalla de Tarjetas.
-- =============================================================================

UPDATE "Tarjetas" t
   SET ultimos_4_digitos = concat_ws(',', NULLIF(t.ultimos_4_digitos, ''), faltantes.lista)
  FROM (
    SELECT p.tarjeta_id,
           string_agg(p.ultimos_4, ',' ORDER BY p.es_activo DESC, p.id DESC) AS lista
      FROM "TarjetaPlasticos" p
      JOIN "Tarjetas" tj ON tj.id = p.tarjeta_id
     WHERE COALESCE(tj.ultimos_4_digitos, '') !~ ('(^|[^0-9])' || p.ultimos_4 || '([^0-9]|$)')
       AND NOT EXISTS (
             SELECT 1 FROM "Tarjetas" otra
              WHERE otra.id <> tj.id
                AND otra.owner_user_id IS NOT DISTINCT FROM tj.owner_user_id
                AND COALESCE(otra.ultimos_4_digitos, '') ~ ('(^|[^0-9])' || p.ultimos_4 || '([^0-9]|$)'))
       AND NOT EXISTS (
             SELECT 1 FROM "CuentasFinancieras" c
              WHERE c.owner_user_id IS NOT DISTINCT FROM tj.owner_user_id
                AND COALESCE(c.ultimos_4_digitos, '') ~ ('(^|[^0-9])' || p.ultimos_4 || '([^0-9]|$)'))
     GROUP BY p.tarjeta_id
  ) faltantes
 WHERE faltantes.tarjeta_id = t.id;
