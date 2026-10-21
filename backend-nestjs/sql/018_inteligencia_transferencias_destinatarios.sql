-- =============================================================================
-- 018 · Inteligencia de transferencias por destinatario — Iteración 3, Fase 5
-- =============================================================================
-- IDEMPOTENTE y ADITIVA.
--
-- Metadatos extraídos de descripción/notas/correos de cada transferencia:
--   es_transferencia               el movimiento es una transferencia a un tercero
--   destinatario_nombre_normalizado nombre del destinatario (sin tildes, mayúsculas)
--   llave_o_identificador          llave Bre-B / Transfiya / celular / alias / correo
--   cuenta_bancaria_destino        número o máscara de la cuenta destino
--   entidad_destino                Bancolombia, Nequi, Daviplata, Davivienda, Nu, Lulo, Bre-B…
--   persona_asociada_id            persona del catálogo resuelta por nombre/llave/alias
--
-- alias_identificadores_persona: lo aprendido ("la cta *4521 es de Paola") para
-- vincular automáticamente transferencias futuras que solo traigan la cuenta/llave.
-- =============================================================================

ALTER TABLE "Transacciones"
  ADD COLUMN IF NOT EXISTS es_transferencia boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS destinatario_nombre_normalizado varchar(150),
  ADD COLUMN IF NOT EXISTS llave_o_identificador varchar(120),
  ADD COLUMN IF NOT EXISTS cuenta_bancaria_destino varchar(80),
  ADD COLUMN IF NOT EXISTS entidad_destino varchar(80),
  ADD COLUMN IF NOT EXISTS persona_asociada_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_transacciones_persona_asociada') THEN
    ALTER TABLE "Transacciones"
      ADD CONSTRAINT fk_transacciones_persona_asociada FOREIGN KEY (persona_asociada_id) REFERENCES "Personas" (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS alias_identificadores_persona (
  id bigserial PRIMARY KEY,
  usuario_id bigint NOT NULL,
  persona_id bigint NOT NULL REFERENCES "Personas" (id) ON DELETE CASCADE,
  tipo_identificador varchar(30) NOT NULL,
  valor_identificador varchar(150) NOT NULL,
  entidad_bancaria varchar(80),
  confianza numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alias_identificador_usuario_tipo_valor
  ON alias_identificadores_persona (usuario_id, tipo_identificador, valor_identificador);

CREATE INDEX IF NOT EXISTS idx_transacciones_persona_asociada
  ON "Transacciones" (persona_asociada_id) WHERE persona_asociada_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_llave
  ON "Transacciones" (owner_user_id, llave_o_identificador) WHERE llave_o_identificador IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alias_persona
  ON alias_identificadores_persona (persona_id);
