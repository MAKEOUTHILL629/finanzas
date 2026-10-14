# Scripts SQL de la base de datos

DDL **idempotente** que lleva la BD real (Supabase) al diseño de `../../base de datos-documentacion.md` y añade lo que pide
la especificación de aportes del carro / cruces / recurrentes por persona. Prisma no gestiona estos objetos (`prisma migrate` no se usa).

| Archivo | Qué hace |
|---|---|
| `001_objetos_documento.sql` | Vistas 4.2 (la antigua `vw_ResumenObligacionesMes` queda como `_legacy`), triggers 1–8, `sp_pagar_extracto_tarjeta`, `sp_registrar_abono_persona`, `sp_actualizar_trm_compra_usd` e índices. Con **guardas** para lo que escribe Scala (sin `owner_user_id`) y las restricciones reales (`monto > 0`). Ver D32–D34 en `MIGRATION_INVENTORY.md`. |
| `002_aportes_cruces_recurrentes.sql` | `ObligacionesMes.saldo_a_favor_aplicado`, columnas de trazabilidad en `AportesDetalle` y `MovimientosDeudaPersona`, tabla `CargosRecurrentesPersona` e índice único de periodo. Solo DDL aditivo. |
| `rollback_001_002.sql` | Reversa manual: restaura los Triggers 3 y 5 y la vista antiguos y borra lo añadido (**borra** `CargosRecurrentesPersona`). No lo aplica el script. |

```bash
npm run build                                   # el aplicador usa dist/config/scala-env
node scripts/aplicar-sql.js --dry-run           # aplica en una transacción y hace ROLLBACK: lista qué cambiaría
node scripts/aplicar-sql.js                     # aplica y confirma (lee ../.env de Scala: DB_URL, DB_USER, DB_PASSWORD)
node scripts/aplicar-sql.js --database-url=postgresql://postgres:postgres@localhost:54329/finanzas_test   # otra base
```

El aplicador compara los objetos antes y después, **aborta si cambia alguna fila** de `MovimientosDeudaPersona` y no imprime credenciales.
Las pruebas de integración (`npm run test:integration`) reconstruyen una BD de prueba con el esquema de Prisma y le aplican estos mismos archivos.
