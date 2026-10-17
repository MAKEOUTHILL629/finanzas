# Finanzas API — NestJS

Migración del microservicio Scala (Play Framework) a **NestJS + Prisma + Supabase (PostgreSQL)**.
Mantiene el contrato HTTP legacy (`/api/*`) para que Angular funcione sin cambios y añade el ERP financiero (cuentas, transacciones,
correos bancarios, recurrentes, obligaciones, sub-ledger y analítica) bajo `/api/*`. Los nombres antiguos `/api/v2/*` siguen
funcionando como alias (ver `MIGRATION_INVENTORY.md` §3).

> Documentos de referencia: [`MIGRATION_INVENTORY.md`](MIGRATION_INVENTORY.md) (rutas, discrepancias y hallazgos) ·
> `../base de datos-documentacion.md` (esquema, triggers y SPs de Supabase).

## Arranque rápido

```bash
cp .env.example .env        # completar DATABASE_URL, DIRECT_URL, JWT_SECRET (= APP_SECRET de Play), WEBHOOK_SECRET y DEFAULT_OWNER_USER_ID
npm install
npm run prisma:generate
npm run start:dev           # http://localhost:9000  ·  Swagger: /api/docs  ·  legacy: /api-docs
```

| Script | Qué hace |
|---|---|
| `npm run build` | `prisma generate` + compilación TypeScript (0 errores) |
| `npm test` | Pruebas unitarias + e2e HTTP con Prisma mockeado (**sin BD**) |
| `npm run test:integration` | Pruebas contra **PostgreSQL real** con triggers y SPs (ver abajo) |
| `npm run openapi:export` | Genera `openapi-generated.json` para `openapi-generator-cli` (Angular) |

## Correos de Bancolombia (`POST /api/notificaciones-correo/sync-batch`)

El Google Apps Script envía los correos parseados por lotes. Autenticación: header `x-webhook-secret` = `WEBHOOK_SECRET`
(actúa como el usuario `DEFAULT_OWNER_USER_ID`) **o** un JWT normal.

```bash
curl -X POST http://localhost:9000/api/notificaciones-correo/sync-batch   -H "x-webhook-secret: $WEBHOOK_SECRET" -H "Content-Type: application/json"   -d '{"items":[{"externalMessageId":"<abc@mail.gmail.com>","fecha":"2026-10-13","hora":"14:02:11","tipo":"Compra",
       "metodo":"Tarjeta Credito","comercio":"EXITO","origenRaw":"T.Cred *1927","valor":"50.000","moneda":"COP"}]}'
```

- **Idempotente**: `INSERT ... ON CONFLICT (external_message_id) DO NOTHING`. Reenviar un lote no duplica nada; `syncedExternalIds`
  incluye nuevos **y** ya existentes para que el script los marque como sincronizados. Un ítem que falla se revierte solo y
  aparece en `errores` (no en `syncedExternalIds`), sin afectar a los demás.
- **Ruteo**: Compra/Avance con tarjeta de crédito → `ComprasCredito` a 1 cuota (notificación `PENDIENTE` para asignar
  cuotas/responsables); Ingreso/Pago proveedor → `INGRESO` confirmado; Transferencia/Pago/Retiro/Compra débito → `EGRESO`
  confirmado; Pago de tarjeta → `PAGO_TARJETA` (el débito y el "abono" del mismo pago, ±5 min y mismo monto, producen **una** sola
  transacción); avisos informativos → `IGNORADO`. Lo que no se puede resolver queda `PENDIENTE` con el `motivo` en `datos_parseados`.
- **Cómo se identifican los productos**: los últimos 4 dígitos del correo se buscan en `CuentasFinancieras.ultimos_4_digitos`
  (admite varios valores: `"3698,4278"`, p. ej. cuenta + tarjeta débito) y en `Tarjetas.ultimos_4_digitos` (también varios: `"1927,9587"` si el
  banco reexpidió la tarjeta; las tarjetas antiguas que llevan el número en la `descripcion` siguen funcionando). Un aviso que no trae número
  («recibiste un pago en tu cuenta de Ahorros») va a la cuenta marcada `es_principal`.
- Conciliación desde Angular: `PATCH /api/notificaciones-correo/:id/conciliar` (confirmar, descartar, cambiar `numeroCuotas`,
  asignar `responsables`, indicar `cuentaId`/`tarjetaId`, `convertirEnPrestamo`). Todo en una sola transacción de BD.
  `tarjetaId` acepta **cualquier** tarjeta (selector único): una de crédito crea la compra a 1 cuota; una de débito registra el movimiento en
  su cuenta. Un aviso en dólares sin tasa pide `tasaCambio` (la TRM, COP por dólar). `fecha` (`yyyy-MM-dd`) corrige el día del movimiento nuevo. Los campos opcionales vacíos (`""`, `null`) se
  tratan como «no enviados» (`VacioAUndefined`/`EnteroOpcional`), no como un 400.

### Correos inteligentes (`src/modules/notificaciones-correo/`)

Cada correo pasa por un **planificador puro** (`planificador-correos.ts`, sin BD) que, con una fotografía en memoria del usuario
(cuentas, tarjetas, personas, compras, transacciones y correos ya procesados), decide qué hacer. La fotografía se carga una vez por lote o
reproceso y se va actualizando, de modo que reprocesar cientos de correos no hace cientos de consultas.

| Situación | Resultado |
|---|---|
| Compra con tarjeta de crédito que **ya existe** (misma tarjeta, fecha ±1 día y monto) | se **enlaza** (`vinculo = EXISTENTE`), no se duplica; cada compra se enlaza a UN correo |
| Compra nueva de un comercio que ya usas | se crea con las **cuotas, responsables y porcentajes** de tus compras anteriores del mismo comercio («plantilla», `vinculo = CREADA`, estado `CONCILIADO`) |
| Compra de un comercio nuevo | 1 cuota sin responsables, `PENDIENTE` para completarla |
| Dos avisos del mismo hecho (misma tarjeta/cuenta, monto y minuto, ≤ 10 min) | el segundo es `DUPLICADO` (`IGNORADO`) |
| Transferencia/Bre-B/QR/retiro/compra débito | transacción en la cuenta de los últimos 4; si ya la registraste a mano (misma cuenta, monto y día) se enlaza |
| Transferencia **recibida** (el script la deja como «Desconocido») | `INGRESO`; se reconoce a la persona por nombre o celular de la llave (`persona_id`) |
| «Compra rechazada / fondos insuficientes», avisos de inscripción | `IGNORADO` |

- **Normalización de comercios** (`comercio.util.ts`): `DL*DIDI FOOD CO`, `DLO*DIDI FOOD CO PAY` y `DIDI FOODS` son «didi food».
  La plantilla solo aprende de compras **revisadas** (correos `CONCILIADO`); lo creado sin tocar (`PENDIENTE`) no es una preferencia.
- **Productos** (`/api/notificaciones-correo/productos…`): lista los últimos 4 que aparecen en los correos y a qué cuenta/tarjeta pertenecen. Las
  tarjetas se asocian **por evidencia** (cada correo cuya fecha y monto coinciden con una compra de la tarjeta X «vota» por X; con ≥ 3 votos y ≥ 75 % se
  guarda sola, también al final de cada `sync-batch`). Las cuentas/débitos se proponen (`aceptar-sugerencias` o `asignar`).
- **Reproceso** (`POST /api/notificaciones-correo/reprocesar`): `simular: true` (por defecto) devuelve el resumen sin escribir; con `simular: false`
  corre en segundo plano (`jobId`, `GET /reprocesar/:jobId`). `desde` (yyyy-MM-dd) es la fecha de corte: antes solo se enlaza, desde ahí se registra lo que falta.
- **Deshacer**: `PATCH /:id/conciliar { accion: "DESCARTAR" }` sobre un correo resuelto por el sistema anula lo que creó; **nunca** borra una compra o
  transacción que ya existía (`vinculo = EXISTENTE`).

## Cobros a personas (`/api/cobros-puntuales`, `/api/cobros`, `/api/publico/cobros`)

- **Gastos repartidos** (la luz, el mercado, una fiesta): `POST /api/cobros-puntuales` con `modoDivision` `IGUAL | PORCENTAJE | MONTO`. Cada participante distinto del
  propietario recibe un cargo `CARGO_COBRO_PUNTUAL` en el sub-ledger (aparece en el bloque «Servicios, mercado y eventos» de su liquidación). La suma de las partes es
  exactamente el total (los centavos sobrantes se reparten); lo que no se reparte es del propietario. Anular conserva los asientos como `ANULADO`.
- **Enlace para compartir** (`POST /api/cobros/enlaces`): guarda una foto de la liquidación de UNA persona (token de 256 bits, vigencia 1–180 días, revocable). Lo que ve la persona
  (`GET /api/publico/cobros/:token`, sin sesión) incluye, por cada cuota de tarjeta, el número de cuota, el porcentaje y de qué compra es.
- **Pago reportado** (`POST /api/publico/cobros/:token/pagos`): monto, fecha, medio, referencia y **comprobante** (JPG/PNG/WebP/PDF ≤ 2.4 MB; se valida la firma del archivo,
  no el tipo declarado; se guarda en `bytea`). Límites: 12 intentos/10 min por enlace y 8 pendientes por enlace.
- **Aprobación** (`POST /api/cobros/reportes/:id/aprobar`): tres caminos — enlazar el ingreso que **ya llegó por correo** (`transaccionId`, sin duplicar el movimiento), registrarlo en una
  cuenta (`cuentaDestinoId`, `sp_registrar_abono_persona`) o solo anotar el abono. Si falta dinero, el saldo queda pendiente y pasa al siguiente cierre como «saldo anterior».
  `GET /api/cobros/ingresos-sugeridos` lista las transferencias recibidas de personas registradas que aún no se aplicaron a su deuda.

## Angular en local

```bash
# 1) backend                                  # 2) frontend (otro terminal)
cd backend-nestjs && npm run start:dev        cd ../finanzas-mf && npm install && npm start
```

`finanzas-mf/proxy.conf.json` reenvía `/api/*` a `http://localhost:9000/api`; Angular usa `apiUrl = '/api'` (mismo origen, sin CORS).
Con `npm run build:docker` el frontend llama directo a `http://localhost:9000/api` (CORS ya permite `localhost:4200/3000`).
Pantallas de Angular que consumen esta API (rutas en `finanzas-mf/src/app/app-routing.module.ts`): `/prestamos` (+ detalle con
aprobaciones, edición, pago y anulación), `/cortes-cobro`, `/obligaciones` (+ detalle y aportes), `/extractos` (pagar extracto),
`/tarjetas` (editar con `PUT /api/tarjetas/:id`), `/cuentas`, `/categorias`, `/transacciones`, `/correos` (bandeja y conciliación),
`/flujo-caja`, `/estado-cuenta` y `/cruces-deuda`. Detalle en el README de `finanzas-mf`.
Las fechas "de calendario" se serializan como epoch-ms a las 00:00 **UTC**; el frontend las formatea en UTC
(`shared/date-only.helper.ts` y `formatoFecha`) para no mostrar el día anterior en Colombia (UTC-5).

## Base de datos: objetos y scripts (`sql/`)

La BD real se gestiona con SQL idempotente de `sql/` (ver `sql/README.md`): triggers, SPs, vistas, las tablas/columnas de aportes del carro y
recurrentes por persona (`002`) y las de correos inteligentes y cobros a personas (`003`). `node scripts/aplicar-sql.js --dry-run` muestra qué cambiaría sin
guardar nada. Reversas: `sql/rollback_001_002.sql`, `sql/rollback_003.sql`.

## Aportes del carro, cruces, recurrentes por persona y liquidación

| Ruta (también bajo `/api/v2/…`) | Qué hace |
|---|---|
| `GET /api/obligaciones-aportes/carro/resumen` | KPIs, saldo a favor global y periodos (más reciente primero) con aportes diarios y desglose |
| `POST /api/obligaciones-aportes/periodos` | Crea o configura la cuota de un mes |
| `POST/PUT/DELETE /api/obligaciones-aportes/aportes-diarios[/:id]` | Aporte con N líneas (`EFECTIVO`, `TRANSFERENCIA`, `CRUCE_CUENTAS`, `SALDO_A_FAVOR`); un cruce a nombre de un tercero se le carga a su cuenta por cobrar; editar/borrar lo revierte |
| `POST /api/obligaciones-aportes/periodos/:id/aplicar-excedente` | Saldo a favor → mes siguiente o abono en el estado de cuenta del responsable |
| `GET/POST/PATCH/DELETE /api/recurrentes-persona` · `POST /generar-mes/:periodo` | Cargos/abonos mensuales por persona, de por vida o por X meses (idempotente) |
| `POST /api/tarjetas` · `POST /api/tarjetas/:id/plasticos` | Crea una tarjeta de crédito o de débito (la de débito exige `cuentaId`), o con `plasticoAnteriorId` renueva un plástico; agrega un plástico anterior sin cambiar el vigente |
| `GET /api/productos-financieros/linea-tiempo` | Periodo de uso de cada tarjeta (por plástico) y cada cuenta, con movimientos y estado |
| `GET /api/sugerencias/formularios` | Valores con los que arrancan los formularios (tarjeta de crédito/débito, cuenta, cuotas, personas) según tu historial reciente |
| `GET /api/sugerencias/comercios?q=&limit=` | Comercios que ya usaste con lo habitual de cada uno (cuotas, tarjeta, categoría, cuenta, responsable) |
| `GET /api/liquidacion-mensual/:periodo[/persona/:id]` | Cuánto debe cada persona a fin de mes (tarjetas, préstamos, recurrentes, cruces, cuota del carro, abonos) |
| `POST /api/liquidacion-mensual/cruce-entre-personas` · `/registrar-pago` | Cruce directo y pago de fin de mes |

Decisiones y mapa respecto a la especificación: D35–D38 en `MIGRATION_INVENTORY.md`.

## Reglas de diseño (inquebrantables)

1. **Dinero con `Decimal`**, nunca `number` (`decimal.js`, precisión 20, `ROUND_HALF_UP`; montos a 2 y tasas/TRM a 4 decimales). `number` solo aparece en la frontera JSON.
2. **`JsonSerializationInterceptor`** convierte `BigInt` (int8) y `Decimal` (numeric) a `number` para Angular.
3. **No se duplica la lógica de la BD**: los 8 triggers y los SPs (`sp_*`) hacen los asientos. NestJS nunca escribe `CuentasFinancieras.saldo_actual` ni inserta en `MovimientosDeudaPersona`.
4. **Recalcular cuotas** (`ComprasCreditoService.reemplazarCuotas`): mismo nº de cuotas → `UPDATE` (el Trigger 8 sincroniza); distinto → borra asientos, recrea cuotas y re-dispara el Trigger 6.
5. **Multi-tenant**: todo se filtra/asigna por `owner_user_id` = `userId` del JWT (`@CurrentUser('userId')`).
6. **Paridad legacy**: mismas rutas, verbos, códigos (200 en POST, 201 solo en `register`, 204 en `logout`), cuerpos de error y formatos de fecha (epoch ms / `MM/dd/yyyy` / `yyyy-MM-ddTHH:mm:ss`).

## Estructura

```
prisma/schema.prisma     22 tablas + 2 vistas (nombres idénticos a la BD)
src/common/              guard JWT, interceptor, filtro, enums, utilidades (calculadora, fechas, Decimal)
src/modules/             auth, personas, tarjetas, compras-credito, consultas-pagos, prestamos, home (legacy)
                         cuentas-financieras, transacciones, notificaciones-correo, gastos-recurrentes,
                         obligaciones-aportes, subledger-deudas (ERP)
test/                    *.spec.ts (unitarias) · e2e/ (HTTP) · integration/ (PostgreSQL real)
```

## Autenticación

JWT HS256 con los mismos claims que Scala (`userId`, `email`, `role`, `name`, `iss="Finanzas Makes"`, `iat`, `exp`) y el mismo
secreto (`JWT_SECRET`, o `APP_SECRET` como respaldo) → **las sesiones activas de Angular siguen siendo válidas**.
Los hashes `bcrypt` de jBCrypt (`$2a$`) son compatibles.

## Pruebas de integración con PostgreSQL real

`npm run test:integration` reconstruye el esquema desde `schema.prisma` y aplica los triggers/vistas/SPs de
`base de datos-documentacion.md` (secciones 4, 8, 10 y 11). **Es destructivo** (`DROP SCHEMA public`), por eso el arnés
se niega a correr salvo contra `localhost` y una base cuyo nombre contenga `test`.

```bash
docker run -d --name pg-test -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=finanzas_test postgres:17
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/finanzas_test npm run test:integration
```

Sin `TEST_DATABASE_URL` esas suites se omiten (`npm test` no las necesita).

## Docker local con reconstrucción automática (API + Angular)

`../docker-compose.local.yml` construye **las dos imágenes** (esta API y `../../finanzas-mf`), las ejecuta dockerizadas contra el
**mismo Supabase que usa Scala** y, con *Compose Watch*, **reconstruye la imagen y recrea el contenedor al guardar un cambio**
(las capas de dependencias quedan en caché: ~25 s por ciclo).

```bash
cd finanzas                                                  # donde está docker-compose.local.yml (y el .env de Scala)
docker compose -f docker-compose.local.yml watch             # construye, arranca y vigila cambios (Ctrl+C deja los contenedores corriendo)
docker compose -f docker-compose.local.yml up -d --build     # alternativa: construir y arrancar sin vigilar
docker compose -f docker-compose.local.yml logs -f api       # logs de la API
docker compose -f docker-compose.local.yml down              # detener y borrar los contenedores
```

| Qué | URL |
|---|---|
| Frontend Angular (nginx; `/api` se reenvía a la API, mismo origen, sin CORS) | http://localhost:8085 |
| API NestJS | http://localhost:9000/health · Swagger http://localhost:9000/api/docs |

- **Configuración = la de Scala, sin cambios.** El contenedor lee el `.env` de `finanzas/` (`DB_URL`, `DB_USER`, `DB_PASSWORD`,
  `APP_SECRET`, `JWT_EXPIRATION`); `src/config/scala-env.ts` deriva de ahí `DATABASE_URL`/`DIRECT_URL` de Prisma
  (`prepareThreshold=0` ⇒ `pgbouncer=true`, pool de 5 como HikariCP, contraseña codificada). `APP_SECRET` sigue siendo la clave JWT,
  así que los tokens existentes siguen valiendo. Un `DATABASE_URL` explícito siempre tiene prioridad.
- Variables solo de NestJS (`WEBHOOK_SECRET`, `DEFAULT_OWNER_USER_ID`, `DEFAULT_TRM_USD`…): copiar `.env.local.example` a `.env.local`.
- Puertos ocupados: `WEB_PORT=8090 API_PORT=9100 docker compose -f docker-compose.local.yml watch`
  (8080, 8082, 8090, 8069 y 5432 suelen estar tomados por otros proyectos locales).
- **No hay base local: es el Supabase real.** Lo que registres desde esta pila queda guardado allí.
- Qué vigila: `src/`, `prisma/`, `public/`, `package*.json`, `tsconfig*.json`, `nest-cli.json` y `Dockerfile` (API);
  `src/`, `public/`, `package*.json`, `angular.json`, `tsconfig*.json`, `nginx.local.conf` y `Dockerfile` (frontend). Los `*.spec.ts` no reconstruyen.

## Docker / AWS

```bash
docker build -t finanzas-api-nestjs .        # multi-stage, node:22-alpine, usuario no-root, tini, HEALTHCHECK /health
docker compose up --build                    # lee .env, expone 9000
```

Puerto `9000` y `GET /health` idénticos a la app Play ⇒ reemplazo directo en ELB/ECS. Variables: ver `.env.example`.
