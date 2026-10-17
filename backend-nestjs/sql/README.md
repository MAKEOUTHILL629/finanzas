# Scripts SQL de la base de datos

DDL **idempotente** que lleva la BD real (Supabase) al diseño de `../../base de datos-documentacion.md` y añade lo que pide
la especificación de aportes del carro / cruces / recurrentes por persona. Prisma no gestiona estos objetos (`prisma migrate` no se usa).

| Archivo | Qué hace |
|---|---|
| `001_objetos_documento.sql` | Vistas 4.2 (la antigua `vw_ResumenObligacionesMes` queda como `_legacy`), triggers 1–8, `sp_pagar_extracto_tarjeta`, `sp_registrar_abono_persona`, `sp_actualizar_trm_compra_usd` e índices. Con **guardas** para lo que escribe Scala (sin `owner_user_id`) y las restricciones reales (`monto > 0`). Ver D32–D34 en `MIGRATION_INVENTORY.md`. |
| `002_aportes_cruces_recurrentes.sql` | `ObligacionesMes.saldo_a_favor_aplicado`, columnas de trazabilidad en `AportesDetalle` y `MovimientosDeudaPersona`, tabla `CargosRecurrentesPersona` e índice único de periodo. Solo DDL aditivo. |
| `003_correos_inteligentes_cobros.sql` | `Tarjetas.ultimos_4_digitos`, `CuentasFinancieras.es_principal`, columnas indexables y vínculos en `NotificacionesCorreo` (rellena las nuevas con lo que ya estaba en `datos_parseados`), tablas `CobrosPuntuales`, `CobrosPuntualesPersonas`, `EnlacesCobroPersona`, `ReportesPagoPersona` y `MovimientosDeudaPersona.cobro_puntual_id`. Solo DDL aditivo: no borra ni reescribe filas existentes. |
| `004_plasticos_tarjeta.sql` | Tabla `TarjetaPlasticos` (cada plástico/reposición de una tarjeta: últimos 4, vigencia, motivo, cuál reemplaza), `ComprasCredito.plastico_id` y relleno de los plásticos a partir de `Tarjetas.ultimos_4_digitos` y de los avisos del banco. Solo DDL aditivo; la línea de crédito (`Tarjetas`) y su historial de compras no cambian. |
| `005_indices_claves_foraneas.sql` | Índices en las ~55 claves foráneas que no tenían (Postgres no las indexa solo) y `ComprasCredito (owner_user_id, fecha_compra DESC)`. Solo `CREATE INDEX IF NOT EXISTS`: no toca filas. |
| `006_tarjetas_debito_cuentas.sql` | `Tarjetas.tipo_tarjeta` (CREDITO/DEBITO), `cuenta_id` (obligatoria en débito), `alias`, `es_generica`; `CuentasFinancieras.es_generica` y `fecha_inicio_uso/fin_uso`. Solo DDL aditivo. |
| `008_cadena_ultimos4_con_todos_los_plasticos.sql` | Agrega a `Tarjetas.ultimos_4_digitos` los plásticos de la tarjeta que faltaban (la lista que lee el parser de correos), sin quitar ni reordenar y sin duplicar un dígito que ya identifique a otra tarjeta o cuenta del dueño. Solo `UPDATE`, idempotente. |
| `007_semilla_productos_financieros.sql` | Semilla idempotente de los 13 productos (9 tarjetas, 3 cuentas y la tarjeta «sin número»): solo crea lo que falta y rellena campos vacíos. El aplicador deja que una semilla agregue filas a tarjetas/plásticos/cuentas y muestra cómo queda. |
| `009_refinanciamiento.sql` | `ComprasCredito.refinanciamiento_id` (FK a sí misma), `es_refinanciamiento`, `saldo_refinanciado`, `sistema_amortizacion` (`CAPITAL_FIJO`/`FRANCES`) y `cuota_fija_pactada`, con sus restricciones e índice parcial. Solo DDL aditivo: ninguna fila existente cambia (todas quedan `CAPITAL_FIJO`, sin vínculo). El vínculo de los refinanciamientos históricos es un paso aparte: `scripts/vincular-refinanciamientos-historicos.js`. |
| `rollback_009.sql` | Reversa manual de `009` (**borra** las columnas de refinanciamiento; las compras no se tocan). No lo aplica el script. |
| `rollback_006_007.sql` | Reversa manual de `006` y `007` (borra lo sembrado si no tiene compras ni transacciones y las columnas añadidas). No lo aplica el script. |
| `rollback_005.sql` | Reversa manual de `005` (solo borra los índices). No lo aplica el script. |
| `rollback_004.sql` | Reversa manual de `004` (**borra** `TarjetaPlasticos` y `ComprasCredito.plastico_id`; las compras no se tocan). No lo aplica el script. |
| `rollback_003.sql` | Reversa manual de `003` (**borra** las tablas de cobros/enlaces/reportes y las columnas añadidas). No lo aplica el script. |
| `rollback_001_002.sql` | Reversa manual: restaura los Triggers 3 y 5 y la vista antiguos y borra lo añadido (**borra** `CargosRecurrentesPersona`). No lo aplica el script. |

```bash
npm run build                                   # el aplicador usa dist/config/scala-env
node scripts/aplicar-sql.js --dry-run           # aplica en una transacción y hace ROLLBACK: lista qué cambiaría
node scripts/aplicar-sql.js                     # aplica y confirma (lee ../.env de Scala: DB_URL, DB_USER, DB_PASSWORD)
node scripts/aplicar-sql.js --database-url=postgresql://postgres:postgres@localhost:54329/finanzas_test   # otra base
```

El aplicador compara los objetos antes y después, **aborta si cambia alguna fila** de `MovimientosDeudaPersona` y no imprime credenciales.
Las pruebas de integración (`npm run test:integration`) reconstruyen una BD de prueba con el esquema de Prisma y le aplican estos mismos archivos.
