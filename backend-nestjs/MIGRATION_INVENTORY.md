# MIGRATION_INVENTORY — Scala (Play) → NestJS

Resultado de la **Fase 0** (auditoría). Fuentes leídas: `conf/routes`, `conf/application.conf`,
`public/swagger/openapi.yaml`, los 10 controladores, `AuthenticatedAction`/`JwtFilter`/`Filters`,
`app/modelo/*`, `app/percistencia/*` (12 repos), `app/servicios/*` (3), `test/**`,
`base de datos-documentacion.md`, `DOCUMENTACION_DELETE_UPDATE.md`,
`DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md`, `README_CSV_UPLOAD.md` y los 4 CSV de ejemplo.

> **Fuente de verdad:** cuando `openapi.yaml` y el código Scala difieren, se respeta el **código Scala**
> (es lo que Angular recibe hoy). Las diferencias están en la sección 4.

---

## 1. Inventario de rutas legacy (`conf/routes`) → NestJS

> `conf/routes` define **36 rutas** (la fila 3 agrupa `/api-docs` y `/api-docs/`). `test/e2e/route-parity.e2e-spec.ts` las verifica una por una.

Convenciones del contrato legacy que se conservan:

* **Todas** las respuestas exitosas son `200 OK`, salvo `register` (`201`) y `logout` (`204`). En Nest
  los `@Post()` son `201` por defecto, por eso cada uno lleva `@HttpCode(200)` explícito.
* Cuerpos de error: `{ "message": ..., "errors": ... }` (compras/responsables/préstamos),
  `{ "mensaje": ... }` (tarjetas), `{ "status": "error", "message": ... }` (auth / JWT).
* JSON de fechas (Play `Json.writes` con `java.util.Date`) = **epoch en milisegundos (number)**.
  Excepciones: `Tarjeta` → `"yyyy-MM-dd'T'HH:mm:ss"`; `/api/pagos/*` → `"MM/dd/yyyy"`.
  Ver `src/common/utils/legacy-format.util.ts`.
* Montos legacy salen como `Float`; en Nest salen como `number` provenientes de `Decimal.toNumber()`.

| # | Verbo | Ruta | Controlador Scala → método | Entrada | Salida (200 salvo nota) | Controlador NestJS |
|---|-------|------|----------------------------|---------|-------------------------|--------------------|
| 1 | GET | `/` | HomeController.index | – | `{application,version,status}` | `HomeController.index` |
| 2 | GET | `/health` | HomeController.health | – | `{status:"UP",database,timestamp}` · 500 `{status:"DOWN",...}` | `HomeController.health` |
| 3 | GET | `/api-docs` · `/api-docs/` | SwaggerController.ui | – | HTML Swagger UI | `SwaggerLegacyController.ui` |
| 4 | GET | `/api-docs/openapi.yaml` | Assets.at | – | YAML legacy | `SwaggerLegacyController.yaml` |
| 5 | GET | `/assets/*file` | Assets.versioned | – | estáticos | `useStaticAssets` en `main.ts` |
| 6 | GET | `/api/tarjetas` | TarjetaControlador.list | – | `Tarjeta[]` (id, franquicia, fechaCreacion ISO, descripcion, tasaInteresCompra, tasaInteresAvance, cuotaManejo, urlInfo, ultimaActualizacionTasas ISO, extractTasas) | `TarjetasController.list` |
| 7 | GET | `/api/tarjetas/balance?mes&year` | balanceTarjeta | query `mes`,`year` (400 `{message:"Datos inválidos"}` si faltan) | `[{tarjeta,franquicia,total_saldo_restante}]` | `TarjetasController.balance` |
| 8 | POST | `/api/tarjetas/actualizar-tasas` | actualizarTasas | – | `{mensaje,total,actualizadas,omitidas,errores,resultados[]}` · 500 `{mensaje}` | `TarjetasController.actualizarTasas` |
| 9 | POST | `/api/tarjetas/:id/actualizar-tasas` | actualizarTasasTarjeta | – | `{mensaje,tarjetaId,franquicia,tasas}` · 404/400/422/500 `{mensaje}` | `TarjetasController.actualizarTasasTarjeta` |
| 10 | GET | `/api/personas` | PersonaControlador.list | – | `[{id,nombre,fechaCreacion,inicialesNombre,colorRepresentativo}]` | `PersonasController.list` |
| 11 | GET | `/api/compras-credito` | ComprasCreditoControlador.list | – | `CompraCredito[]` (incluye `responsables` "1,2" y `porcentajePago` = Σ) | `ComprasCreditoController.list` |
| 12 | GET | `/api/compras-credito/detalle/:id` | listById | – | `CompraCredito` ó `null` | `ComprasCreditoController.detalle` |
| 13 | POST | `/api/compras-credito` | create | `{concepto,valorCompra,fechaCompra,numeroCuotas,interes,descripcion,estado,tarjeta}` | `{message,id}` · 400 `{message:"Datos inválidos",errors}` · 500 | `ComprasCreditoController.create` |
| 14 | PUT | `/api/compras-credito` | update | idem + `id` | `{message}` · 400 · 500 | `ComprasCreditoController.update` |
| 15 | DELETE | `/api/compras-credito/:id` | delete | – | `{message}` · 500 `{message}` | `ComprasCreditoController.remove` |
| 16 | POST | `/api/compras-credito/upload-csv` | uploadCsv | multipart `file` | `text/csv` (mismo CSV + columna `Resultado`) · 400 `{message}` | `ComprasCreditoController.uploadCsv` |
| 17 | POST | `/api/recalcular-compra-credito` | recalcularCuotas | idem #14 | **entero** (filas afectadas, no lista) | `ComprasCreditoController.recalcular` |
| 18 | GET | `/api/compras-credito/:id` | CuotaDetalleControlador.listById | – | `CuotaDetalle[]` (id,numeroCuota,fechaPago,saldoRestante,interesPagado,aporteCapital,pagoTotal,compra,estado) | `CuotasDetalleController.listByCompra` |
| 19 | GET | `/api/compras-credito/:id/responsables` | ResponsableCompraCreditoControlador.listByCompraCredito | – | `Responsable[]` | `ResponsablesController.listByCompra` |
| 20 | POST | `/api/compras-credito/responsables` | saveReponsableCredito | `{persona,porcentajePago,cantidadPago,cantidadCuotas,compraCredito}` | `{message,id}` | `ResponsablesController.create` |
| 21 | PUT | `/api/compras-credito/responsables` | update | idem + `id` | `{message}` | `ResponsablesController.update` |
| 22 | DELETE | `/api/compras-credito/responsables/:id` | delete | – | `{message}` · 500 `{message}` | `ResponsablesController.remove` |
| 23 | GET | `/api/prestamos` | PrestamoControlador.list | – | `Prestamo[]` | `PrestamosController.list` |
| 24 | POST | `/api/prestamos` | save | `{valorPrestado,concepto,fechaCobro,responsable,estado,comentarios}` | `{message,id}` | `PrestamosController.create` |
| 25 | GET | `/api/tarjetas/pagos` | ComprasCreditoControlador.pagoTotalMesTarjeta | – | `[{valorPago,tarjeta,fechaPago}]` | `PagosTarjetaController.pagoTotalMes` |
| 26 | GET | `/api/tarjetas/pagos/:id?mes&year` | pagoTotalMesTarjetaDetalle | query `mes`,`year` (400 si faltan) | `CuotaDetalleMes[]` | `PagosTarjetaController.detalle` |
| 27 | POST | `/api/compras-credito/pagar-productos` | pagarProductosTarjetaCredito | – | `true` | `ComprasCreditoController.pagarProductos` |
| 28 | POST | `/api/compras-credito/ajustar-interes-compras/:id` | cambioEstadoAjusteInteres | – | `{message:"Estado cambiado"}` | `ComprasCreditoController.ajustarInteres` |
| 29 | GET | `/api/pagos/personas` | ConsultasPagosControlador.listPagosMensualesPersona | – | `[{persona,fecha "MM/dd/yyyy",valorPago}]` | `ConsultasPagosController.listPagosMensualesPersona` |
| 30 | GET | `/api/pagos/personas/:id?mes&year` | ListPagosMensualesResponsableDetalle | `mes`,`year` opcionales (default = mes actual) | `[{persona,compraCredito,concepto,porcentaje,cantidadCuotaTotal,numeroCuota,fechaPago "MM/dd/yyyy",valorPagoCuota,valorPagoResponsable,tarjeta,estado,interesPagado,aporteCapital,saldoRestante}]` | `ConsultasPagosController.detalleResponsable` |
| 31 | POST | `/api/auth/login` | AuthController.login | `{email,password}` | `{status:"ok",token}` · 400/401/500 `{status:"error",message}` | `AuthController.login` (`@Public`) |
| 32 | POST | `/api/auth/register` | register | `{email,password(≥8),name?}` | **201** `{status,message,user{id,email,role,name,avatarUrl}}` · 409 | `AuthController.register` (`@Public`) |
| 33 | GET | `/api/auth/callback/:provider` | oauthCallback | – | **501** `{status:"pending",message,received_params}` | `AuthController.oauthCallback` (`@Public`) |
| 34 | POST | `/api/auth/logout` | logout (requiere auth) | – | **204** | `AuthController.logout` |
| 35 | GET | `/api/auth/token-is-valid` | tokenIsValid | header `Authorization: Bearer` | `{status:"ok"}` · 400/401 | `AuthController.tokenIsValid` (`@Public`) |

### Orden de rutas (colisiones Play vs. Nest)
Play resuelve por orden de archivo; Nest por orden de registro. Se declaran primero las rutas estáticas
(`responsables`, `upload-csv`, `pagar-productos`, `detalle/:id`, `ajustar-interes-compras/:id`) y al final `GET :id`.
La prueba `test/e2e/route-parity.e2e-spec.ts` lee `../conf/routes` y falla si alguna ruta devuelve 404.

---

## 2. Contrato de autenticación a preservar

| Elemento | Valor legacy | Implementación NestJS |
|----------|--------------|-----------------------|
| Algoritmo | HS256 (`jwt-scala`) | `passport-jwt` / `jsonwebtoken` HS256 |
| Secreto | `play.http.secret.key` ← env `APP_SECRET` | `JWT_SECRET`, con **fallback a `APP_SECRET`** (drop-in) |
| Expiración | env `JWT_EXPIRATION` (segundos) | `JWT_EXPIRATION` (default 3600) |
| Claims | `userId`(number), `email`, `role`, `name`, `iss="Finanzas Makes"`, `iat`, `exp` | idénticos → los tokens vigentes de Angular siguen siendo válidos |
| Rutas públicas | prefijos `/api/auth/login`, `/register`, `/callback/`, `/token-is-valid`; todo lo que no empieza por `/api/` | `@Public()` en esas rutas + Home/Swagger |
| `OPTIONS` | pasa sin JWT | `enableCors` resuelve el preflight antes del guard |
| 401 sin header | `{status:"error",message:"Authorization header required"}` | `JwtAuthGuard` / filtro |
| 401 token inválido | `{status:"error",message:"Invalid or expired token",details}` | idem |
| Password | `jbcrypt` (`$2a$`) | `bcrypt` (compatible con `$2a$`/`$2b$`) |
| Rol por defecto en registro | `"user"` | `"user"` |

CORS (`application.conf`): orígenes `localhost:4200`, `localhost:3000`, `d2k6anvt1vxcuu.cloudfront.net`,
`https://www.makefinanzas.lat`, `makefinanzas.lat`; métodos GET/POST/PUT/DELETE/OPTIONS/PATCH;
headers `Accept, Content-Type, Authorization, X-Requested-With`; credenciales; `maxAge` 3600 s.
Puerto `9000`.

---

## 3. Mapa de rutas ERP (Supabase)

Todas cuelgan de `/api/*` con los nombres del plan. Los nombres de la primera entrega (`/api/v2/*`) siguen respondiendo:
un middleware (`reescribirAliasV2`, `src/app.setup.ts`) reescribe la URL antes del enrutado, de modo que Swagger solo documenta
las rutas actuales. Alias: `/api/v2/subledger/*` → `/api/ledger/*`, `/api/v2/dashboard/*` → `/api/analytics/*`,
`/api/v2/plantillas-recurrentes` → `/api/recurrentes/plantillas`, `/api/v2/periodos-recurrentes[/proyectar|/:id/registrar-pago]` →
`/api/recurrentes/periodos[…]`, y cualquier otro `/api/v2/x` → `/api/x`. Donde se documenta `PUT`, el verbo `PATCH` también responde (oculto en Swagger).

| Verbo | Ruta | Módulo | Mecanismo en BD |
|-------|------|--------|-----------------|
| PATCH | `/api/compras-credito/:id/confirmar-trm` | compras-credito | `sp_actualizar_trm_compra_usd` (Trigger 8 sincroniza sub-ledger) |
| PUT | `/api/compras-credito/:id` | compras-credito | misma lógica que `PUT /api/compras-credito` (el `id` va en la ruta); registrada después de `/responsables` para no taparla |
| POST | `/api/tarjetas/:id/pagar-extracto` | tarjetas | `sp_pagar_extracto_tarjeta` |
| GET | `/api/tarjetas/resumen-mensual?periodo` | tarjetas | consulta 7.3 (corregida, D16) |
| CRUD | `/api/cuentas-financieras` | cuentas-financieras | `saldo_actual` solo lo toca el Trigger 2 |
| CRUD | `/api/categorias` | cuentas-financieras | `owner_user_id IS NULL` + propias |
| CRUD | `/api/transacciones` (`?periodo=YYYY-MM`, `tipo`, `estado`, `cuentaId`…; `DELETE` = anular) | transacciones | Trigger 2 |
| GET | `/api/notificaciones-correo?estado_procesamiento=` | notificaciones-correo | bandeja de conciliación |
| POST | `/api/notificaciones-correo/sync-batch` | notificaciones-correo | webhook del Apps Script (§6), `ON CONFLICT (external_message_id) DO NOTHING` |
| POST | `/api/notificaciones-correo/ingesta` | notificaciones-correo | ingesta de un correo (heurística de últimos 4) |
| PATCH | `/api/notificaciones-correo/:id/conciliar` | notificaciones-correo | Trigger 2 al pasar a `CONFIRMADO`; Regla 4 al cambiar cuotas; Trigger 6 al asignar responsables |
| CRUD | `/api/recurrentes/plantillas` (+ responsables) | gastos-recurrentes | – |
| GET | `/api/recurrentes/periodos?periodo&estado` | gastos-recurrentes | – |
| POST | `/api/recurrentes/proyectar-mes` (`{periodo}`) | gastos-recurrentes | SQL 6.2.C (promedio móvil de 3 pagos reales) |
| PATCH | `/api/recurrentes/periodos/:id/pagar` | gastos-recurrentes | Trigger 7 |
| CRUD | `/api/cortes-cobro` · `GET /api/cortes-cobro/activo` | prestamos | – |
| GET/PATCH | `/api/prestamos/:id` | prestamos | Trigger 4 (la lista `GET/POST /api/prestamos` es la legacy, con extras Supabase y `aprobaciones`) |
| GET/PATCH | `/api/prestamos/:id/aprobaciones` · `/:aprobacionId` | prestamos | `PATCH …/aprobaciones` resuelve "mi" aprobación por `Personas.linked_user_id` |
| GET/POST | `/api/obligaciones-mes` · `GET /:id/resumen` · `GET /:id/dias` | obligaciones-aportes | `vw_ResumenObligacionesMes`, `vw_AportesDiaResumen` |
| GET/POST | `/api/obligaciones-mes/:id/aportes-dia` | obligaciones-aportes | Trigger 3 |
| GET/POST | `/api/cruces-deuda` | subledger-deudas | Trigger 5 |
| POST | `/api/personas/:id/abonar` | subledger-deudas | `sp_registrar_abono_persona` |
| GET | `/api/ledger/estado-cuenta?periodo` | subledger-deudas | consulta 7.1 |
| GET | `/api/ledger/personas/:personaId/extracto?periodo` | subledger-deudas | consulta 7.2 |
| GET | `/api/analytics/flujo-caja?periodo` | subledger-deudas | consulta 7.4 |

---

## 4. Discrepancias detectadas (plan ↔ código Scala ↔ BD) y decisión tomada

| # | Hallazgo | Decisión |
|---|----------|----------|
| D1 | El archivo del plan se llama `plan_maestro_de_migraci_n_scala_a_nestjs_para_agente_ia.md`; no existe `CLAUDE_MIGRATION_MASTER_PLAN.md`. | Se usó el primero (único plan en el repo). |
| D2 | **Regla de primera cuota.** El plan dice `día < 15` → fin de mes actual. `CalculadoraAmortizacion.calcularFechaPrimeraCuota` usa `día <= 15`, pero `CompraCreditoServicio.save` usa `día < 15` para `fecha_ultima_cuota` (el propio legacy es inconsistente el día 15). | **Decisión del usuario: dejarlo como en Scala.** La calculadora usa `<= 15` (es lo que generó las cuotas ya guardadas en BD) y `fecha_ultima_cuota` se deriva de la última cuota calculada, igual que ya hace `recalcularCuotas`; coincide con Scala todos los días salvo el 15. Si hay `Tarjetas.dia_corte`, se usa `día <= dia_corte`. |
| D3 | `CompraCreditoServicioTest.scala` solo verifica llamadas a mocks (y ni siquiera compila con el constructor actual de `CompraCreditoServicio`). No hay valores numéricos que igualar "al centavo". | Se portó el comportamiento (delete+saveBatch+update, resultado `1`) y se añadieron vectores numéricos calculados a mano con el algoritmo Scala. |
| D4 | `PUT /api/compras-credito`: las `Reads` ponen `pagoMensual = valorCompra`, así que el legacy dejaba `pago_mensual` = valor total. | Se calcula `pago_mensual` correctamente (`valor/n + interés`), igual que en `save`. |
| D5 | `POST /api/recalcular-compra-credito` documenta "lista de cuotas" en OpenAPI, pero el código devuelve un entero (`updateResult`). | Se devuelve el entero (paridad con lo que recibe Angular hoy). |
| D6 | `ResponsablesCompraCreditoRepositorio.list*` leía `porcentaje_pago`/`cantidad_pago` con `getInt` (truncaba decimales). | Se devuelven los valores exactos (`numeric`). Es un superconjunto compatible. |
| D7 | `register` devolvía `id = 1` siempre (el `User` se construye con `id=1` y no se relee el `RETURNING id`). | Se devuelve el `id` real. |
| D8 | El CSV usa `SimpleDateFormat` permisivo: `05-04-2024` se parsea con `yyyy-MM-dd` como año 5. El README promete `dd-MM-yyyy`. | Parser estricto por regex con los formatos del README (+ `yyyy.MM.dd` del CSV de ejemplo); si nada coincide, fecha actual (igual que legacy). |
| D9 | Estados: la BD documenta `ACTIVA/PAGADA/PENDIENTE/FACTURADA`; el legacy escribe `Pendiente/Pagado/Ajuste Interes` y Angular los consume. El Trigger 8 solo promueve el sub-ledger con `FACTURADA`/`PAGADA`. | Se conservan los literales legacy; las consultas comparan con `UPPER()`. Las cuotas "Pagado" legacy no promueven el sub-ledger (igual que hoy). |
| D10 | El legacy no filtraba por usuario (sin `owner_user_id`). | Regla 5: todo se filtra/asigna por `owner_user_id` del JWT. Si hay filas legacy con `owner_user_id NULL` no se verán hasta ejecutar el backfill de la sección 5 del documento de BD. |
| D11 | `Float` en Scala vs `Decimal`: p. ej. `interes=1.8895f` se convertía a `1.88949990…`. | Con `Decimal` el cálculo es exacto; las cuotas pueden diferir ≤ 0.01 en casos límite de redondeo (mejora intencional por Regla 1). |
| D12 | `login` no verifica `is_active`. | Paridad (no se cambia). Se deja anotado como mejora futura. |
| D13 | `cambioEstado()` existe en el servicio pero no tiene ruta. | Se migra el método (`ComprasCreditoService.cambioEstado`), sin ruta nueva. |
| D14 | `ConsultasPagos` `/api/pagos/personas` documenta `mes/year` pero el código los ignora en el listado general. | Paridad: se ignoran. |
| D15 | El documento de BD dice "21 tablas" pero define **22** (secciones 3.1–3.22, incluida `linked_accounts`). | Se mapearon las 22 + 2 vistas en `schema.prisma`. |
| D16 | **Consulta 7.3 del documento (resumen por tarjeta) multiplica filas** cuando una compra tiene ≥ 2 terceros responsables (`total_extracto_cop` salía duplicado) y devuelve 0 en terceros si el usuario no tiene Persona enlazada (`rcc.persona <> NULL`). | Reescrita con un CTE que agrega el % de terceros por compra y `IS DISTINCT FROM`. Mismas columnas y mismo resultado en el caso simple. Cubierto por prueba de integración. |
| D17 | **`sp_registrar_abono_persona(..., p_liquidar_prestamos_corte_id)` falla si existe el `CHECK (monto > 0)` de `MovimientosDeudaPersona`**: el SP pone `saldo_pendiente = 0` y `estado = 'Pagado'` en el mismo UPDATE y el Trigger 4 intenta abonar `COALESCE(0, valor)` = 0. | La API responde 422 explicativo (transacción revertida, no queda nada a medias). **Acción recomendada en Supabase:** que `fn_sync_prestamo_to_subledger` omita el abono cuando el monto sea 0. Sin `liquidarPrestamosCorteId` el SP funciona. |
| D18 | `PATCH /api/v2/prestamos/:id` → `Pagado`: si se pusiera `saldo_pendiente = 0` en el mismo UPDATE, el Trigger 4 abonaría 0. | Se cambia primero el estado (abono por el saldo real) y **después** se pone el saldo en 0. |
| D19 | `Personas.owner_user_id` no está en el script de backfill (sección 5) y la Regla 5 filtra por él. | **Verificar en Supabase** que todas las personas tengan `owner_user_id`; si no, `GET /api/personas` las ocultará. |
| D20 | `SimpleDateFormat` del legacy ignora sufijos (`2024-04-05T10:00:00Z` funciona). | Se acepta el mismo prefijo `yyyy-MM-dd` en `fechaCompra` y `fechaCobro`. |
| D21 | Nombres de rutas ERP: la primera entrega las publicó bajo `/api/v2/*`; el plan de la fase 2 las nombra sin `v2` (`/api/ledger/*`, `/api/analytics/*`, `/api/recurrentes/*`…). | Rutas renombradas al plan; `/api/v2/*` queda como alias por reescritura de URL (§3). |
| D22 | **Fechas de calendario como epoch-ms.** El backend las emite a las 00:00 UTC (`@db.Date`); Angular las formateaba con la zona del navegador (UTC-5): `5 oct` se veía `4 oct` y, al editar y guardar, se reenviaba la fecha corrida un día. El legacy dependía de `ZoneId.systemDefault()` del servidor. | Se arregló en el frontend (independiente de la zona del servidor): `formatDateOnly`/`partesFechaCalendario` (`shared/date-only.helper.ts`), pipe `formatoFecha` y `date:'dd/MM/yyyy':'UTC'` en préstamos. Los `Date` locales y los `yyyy-MM-dd` no se tocan. |
| D23 | **Identificación de producto en los correos.** `Tarjetas` no tiene columna de últimos 4 dígitos y una misma cuenta puede tener tarjeta débito con otro número. | `CuentasFinancieras.ultimos_4_digitos` admite varios valores (`"3698,4278"`); los de una tarjeta de crédito se buscan en `Tarjetas.descripcion`/`franquicia` (p. ej. `Visa Oro *1927`). Sin coincidencia única → notificación `PENDIENTE` (`cuenta_no_identificada` / `tarjeta_no_identificada`). |
| D24 | Compras en USD por correo necesitan TRM, que el correo no trae. | Se usa la tasa de la última compra/transacción en USD del usuario; si no hay, `DEFAULT_TRM_USD`; si tampoco, `PENDIENTE` con `trm_no_disponible`. Las compras creadas quedan con `trm_confirmada=false` para usar `confirmar-trm`. |
| D25 | `PAGO_TARJETA` exige `tarjeta_pagada_id`, pero el correo del débito en cuenta puede no identificar la tarjeta. | Solo para `EMAIL_AUTO` se permite crear el pago sin tarjeta (motivo `pago_tarjeta_sin_tarjeta_identificada`) para que el saldo de la cuenta sea correcto; el abono de la tarjeta (otro correo) la completa si llega. |
| D26 | El webhook no tiene usuario autenticado (Apps Script). | `x-webhook-secret` ⇒ actúa como `DEFAULT_OWNER_USER_ID`. **Limitación:** un secreto = un usuario; para varios usuarios habría que emitir un secreto por usuario. Comparación en tiempo constante (sha256 + `timingSafeEqual`); secreto incorrecto → 401 `{status:'error',message:'Invalid webhook secret'}`. |
| D27 | Observado en Angular (previo a esta migración, sin relación con el backend): `NG0100 ExpressionChangedAfterItHasBeenChecked` en `AppComponent` (modo dev) y una petición `GET /api/compras-credito/undefined/responsables` (400) al abrir el detalle de una compra, antes de que el componente hijo reciba el `id`. | Sin cambios (el legacy respondía igual: 400 por `Int` inválido). Pendiente de corregir en el frontend. |

---

## 5. Verificación realizada

| Capa | Archivos | Resultado |
|------|----------|-----------|
| Compilación | `npm run build` (+ `npx prisma generate`) | 0 errores |
| Unitarias + e2e HTTP (Prisma mockeado) | `test/*.spec.ts`, `test/e2e/*` — 16 suites | **431 pruebas OK** (incluye normalizador Bancolombia, `SyncBatchService`, guard del webhook, alias `/api/v2`, `conciliar` extendido, aprobación por persona) |
| Contra **PostgreSQL 17 real** con triggers/SPs/vistas | `test/integration/*.int-spec.ts` — 5 suites | **57 pruebas OK** (`npm run test:integration`); `sync-batch.int-spec.ts` cubre lote mixto, idempotencia, **carrera de dos lotes idénticos**, deduplicación débito/abono, multi-tenant y conciliación (Regla 4 + Trigger 6) |
| Humo del binario compilado | `node dist/main.js` + HTTP real | `/api/docs` 200 (61 rutas), webhook: sin credenciales 401, secreto malo 401, secreto bueno 200, reintento idempotente; preflight CORS permite `x-webhook-secret` |
| Frontend | `finanzas-mf`: `ng build` (development, production y docker) · `ng test` (39 pruebas, Edge headless) | OK |
| Angular ↔ NestJS en navegador | `npm start` (proxy `/api` → `:9000`) + login real: lista de compras, detalle, préstamos, pagos del mes, pagos por persona | Todas las peticiones 200; fechas correctas tras D22 |
| Paridad de rutas | `test/e2e/route-parity.e2e-spec.ts` lee `../conf/routes` | todas las rutas legacy existen con su verbo; rutas ERP y alias verificados |
| `docker build` | `Dockerfile` | **No verificado** (el daemon de Docker no estaba en ejecución) |

Lo que NO se pudo verificar: ejecución contra el **Supabase real** (sin credenciales de prueba; las pruebas usan PostgreSQL 17 embebido con
el mismo DDL/triggers/SPs del documento), la imagen Docker, y el **Google Apps Script** (no está en el repositorio; el contrato de §6
se probó con lotes sintéticos).

---

## 6. Contrato de `POST /api/notificaciones-correo/sync-batch`

**Autenticación:** `x-webhook-secret: <WEBHOOK_SECRET>` (usuario `DEFAULT_OWNER_USER_ID`) o `Authorization: Bearer <jwt>`.

**Cuerpo:** `{ "items": [ … ] }` (también se acepta `{ "notificaciones": [ … ] }` o un arreglo directo; máx. 500 ítems). Cada ítem:

| Campo | Tipo | Notas |
|-------|------|-------|
| `externalMessageId` | string, **obligatorio** | clave de idempotencia (Message-ID de Gmail) |
| `fecha` · `hora` | `YYYY-MM-DD` · `HH:mm[:ss]`, **obligatorios** | hora local de Colombia (`SYNC_TZ_OFFSET`, por defecto `-05:00`) |
| `tipo` · `metodo` | string, **obligatorios** | `Compra`, `Avance`, `Ingreso`, `Pago`, `Transferencia`, `Retiro`, `Abono Tarjeta`… × `Tarjeta Credito`, `Tarjeta Debito`, `Cuenta Ahorros`, `QR`, `Llaves`, `Pago Tarjeta`… |
| `comercio` · `origenRaw` | string | `origenRaw` trae los últimos 4 (`T.Cred *1927`, `Cuenta *3698`) |
| `valor` | string o number | formato colombiano (`1.250.000,50`) o decimal; se normaliza con `Decimal` |
| `moneda` | `COP` o `USD` | por defecto `COP` |
| `asunto` · `cuerpoExtraido` · `linkCorreo` | string | se guardan para auditoría |
| `esErrorParsing` | boolean | `true` ⇒ `IGNORADO` |

**Respuesta 200:** `{ totalRecibidos, nuevosInsertados, yaExistentesIdempotentes, syncedExternalIds[], errores[{externalMessageId,error}], detalle[{externalMessageId, resultado: INSERTADO|EXISTENTE|ERROR, ruta, estadoProcesamiento, transaccionId, compraCreditoId, motivo}] }`.
`400` con `{message, errors}` indica qué ítem y campo son inválidos (el lote completo se rechaza antes de tocar la BD).

**Ruteo:** ver README ("Correos de Bancolombia"). Los ítems se procesan en orden cronológico (el débito antes que el abono del mismo pago), cada uno en su propia transacción.
