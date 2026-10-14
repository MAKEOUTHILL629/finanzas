# PLAN MAESTRO DE MIGRACIÓN Y ARQUITECTURA: SCALA (PLAY FRAMEWORK) $\rightarrow$ NESTJS + SUPABASE + ANGULAR

> **INSTRUCCIÓN DIRECTA PARA EL AGENTE DE IA (CLAUDE SONNET):**
> Actúa como un **Arquitecto de Software Principal y Especialista en Sistemas Financieros (Backend NestJS + PostgreSQL/Supabase + Angular)**. Tu misión es ejecutar la migración completa, sin regresiones y libre de errores, del microservicio actual escrito en **Scala (Play Framework)** hacia una arquitectura moderna, modular y extensible en **NestJS (TypeScript)** dentro de la subcarpeta `./backend-nestjs/`.
> 
> **REGLA DE ORO DE EJECUCIÓN:** No asumas ni inventes contratos, nombres de columnas ni reglas financieras. Antes de escribir código en cada fase, **debes leer los archivos fuente del repositorio Scala actual** y cruzarlos con las especificaciones de este documento.

---

## 1. CONTEXTO Y DELIMITACIÓN DEL ESPACIO DE TRABAJO (WORKSPACE)

Te encuentras en la raíz del repositorio del proyecto actual en Scala. La estructura se divide así:

1. **Código Fuente Legacy (SOLO LECTURA - PROHIBIDO MODIFICAR O ELIMINAR):**
   * `conf/routes` y `public/swagger/openapi.yaml` $\rightarrow$ Contratos HTTP actuales que consume la aplicación en Angular.
   * `app/controllers/*` $\rightarrow$ 10 controladores actuales (`AuthController`, `ComprasCreditoControlador`, `ConsultasPagosControlador`, `CuotaDetalleControlador`, `HomeController`, `PersonaControlador`, `PrestamoControlador`, `ResponsableCompraCreditoControlador`, `SwaggerController`, `TarjetaControlador`).
   * `app/controllers/actions/AuthenticatedAction.scala` y `app/controllers/filters/JwtFilter.scala` $\rightarrow$ Lógica de autenticación JWT actual.
   * `app/modelo/*` $\rightarrow$ Modelos de dominio y `CalculadoraAmortizacion`.
   * `app/percistencia/*` $\rightarrow$ 12 archivos de repositorio SQL/Play.
   * `app/servicios/*` $\rightarrow$ `CompraCreditoServicio.scala`, `PagosServicio.scala`, `WebScrapingServicio.scala`.
   * `test/servicios/CompraCreditoServicioTest.scala` $\rightarrow$ Suite de pruebas unitarias de referencia.
   * Documentación técnica en la raíz: `base de datos-documentacion.md`, `ARQUITECTURA_Y_ANALISIS.md`, `DOCUMENTACION_DELETE_UPDATE.md`, `DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md`, `README_CSV_UPLOAD.md`.

2. **Nuevo Proyecto Destino (LECTURA Y ESCRITURA):**
   * Todo el nuevo backend debe crearse exclusivamente dentro del subdirectorio: `./backend-nestjs/`.

---

## 2. REGLAS INQUEBRANTABLES (GUARDRAILS ANTI-BUGS FINANCIEROS)

Cualquier violación a estas 6 reglas se considera un fallo crítico de arquitectura:

### Regla 1: Prohibición Absoluta de `number` (IEEE 754) para Cálculos Monetarios
* En PostgreSQL (Supabase), todas las columnas monetarias y tasas fueron migradas de `float4`/`float8` a `numeric`.
* **PROHIBIDO** realizar operaciones aritméticas (`+`, `-`, `*`, `/`) con el tipo `number` nativo de JavaScript/TypeScript.
* **OBLIGATORIO:** Usa exclusivamente `Decimal` de la librería `decimal.js` (o `Prisma.Decimal`) para cualquier cálculo de cuotas, saldos, amortizaciones, tasas de interés, porcentajes de participación y conversión de divisas (`USD` $\rightarrow$ `COP`).
* Configura el redondeo financiero estándar: `Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })`. Redondea montos finales en moneda a $2$ decimales (`.toDecimalPlaces(2)`) y tasas/TRM a $4$ decimales (`.toDecimalPlaces(4)`).

### Regla 2: Serialización Transparente de `BigInt` (`int8`) y `Prisma.Decimal` (`numeric`) hacia Angular
* En Supabase las llaves primarias y foráneas son `int8` (mapeadas por Prisma como `bigint`) y los montos son `numeric` (mapeados como `Prisma.Decimal`).
* Por defecto, `JSON.stringify()` lanza `TypeError: Do not know how to serialize a BigInt` y serializa `Prisma.Decimal` como `string`.
* **OBLIGATORIO:** Implementa un `JsonSerializationInterceptor` global en `src/common/interceptors/json-serialization.interceptor.ts` que transforme recursivamente en las respuestas HTTP:
  * `typeof val === 'bigint'` $\rightarrow$ `Number(val)` (siempre que esté dentro de `Number.MAX_SAFE_INTEGER`).
  * `val instanceof Prisma.Decimal` o `Decimal.isDecimal(val)` $\rightarrow$ `val.toNumber()` para mantener compatibilidad 100% con los componentes y gráficas existentes en Angular.
  * Instancias `Date` $\rightarrow$ ISO String (`YYYY-MM-DD` o ISO-8601 según lo que devuelva el endpoint original en Scala).

### Regla 3: Coordinación Estricta con los Triggers y Stored Procedures de Supabase
La base de datos en Supabase ya posee **8 Triggers transaccionales** y **3 Stored Procedures (`sp_*`)** activos. **NO dupliques su lógica en código TypeScript** para no generar asientos contables dobles:
1. **`trg_set_periodo_cuota` (`CuotasDetalle`):** Calcula automáticamente `periodo_facturacion = to_char(fecha_pago, 'YYYY-MM')` si viene nulo (aunque puedes enviarlo explícitamente).
2. **`trg_actualizar_saldo_cuenta` (`Transacciones`):** Suma o resta automáticamente `CuentasFinancieras.saldo_actual` cuando se inserta, actualiza o elimina una transacción con `estado = 'CONFIRMADO'`. **Prohibido hacer `UPDATE "CuentasFinancieras" SET saldo_actual = ...` desde NestJS.**
3. **`trg_before_insert_aporte_detalle` (`AportesDetalle`):** Cuando un tercero (distinto al responsable principal de la meta y distinto al usuario dueño) hace un aporte diario al carro/casa, el trigger crea automáticamente el registro en `Prestamos` y las 2 filas en `AprobacionesPrestamos`. **Prohibido crear ese préstamo manualmente en NestJS.**
4. **`trg_sync_prestamo_subledger` (`Prestamos`):** Al insertar un préstamo o cambiar su estado a `'Pagado'`, el trigger inserta automáticamente el cargo (`+1`) o el abono (`-1`) en `MovimientosDeudaPersona`.
5. **`trg_after_insert_cruce_deuda` (`CrucesDeuda`):** Al insertar en `CrucesDeuda`, el trigger inserta automáticamente el par contable (`-1` y `+1`) en `MovimientosDeudaPersona`.
6. **`trg_after_insert_responsable_tc` (`ResponsablesComprasCredito`):** Al insertar o actualizar un responsable de compra con tarjeta, el trigger lee `CuotasDetalle` y crea los cargos (`CARGO_CUOTA_TC`) en `MovimientosDeudaPersona`.
7. **`trg_after_update_periodo_recurrente` (`PeriodosRecurrentes`):** Cuando un periodo recurrente pasa a `'FACTURADO'` o `'PAGADO'`, el trigger reparte e inserta los cargos (`CARGO_GASTO_COMPARTIDO`) en `MovimientosDeudaPersona`.
8. **`trg_sync_update_cuota_subledger` (`CuotasDetalle`):** Cuando se actualiza `pago_total` o `estado` en `CuotasDetalle`, el trigger actualiza automáticamente el `monto` y `estado` en `MovimientosDeudaPersona`.

### Regla 4: Cuidado Crítico al Recalcular Cuotas (`CuotasDetalle`) vs. Sub-Ledger
* En el código legacy de Scala (`CompraCreditoServicio.scala`), los métodos `recalcularCuotas` y `ajusteInteresTarjetaCredito` hacían `deleteByCompra` seguido de `saveBatch`.
* En el nuevo esquema de Supabase, `MovimientosDeudaPersona.cuota_detalle_id` tiene una llave foránea hacia `CuotasDetalle.id`, y el Trigger 8 (`trg_sync_update_cuota_subledger`) escucha eventos `AFTER UPDATE ON "CuotasDetalle"`.
* **Cómo implementarlo en NestJS:**
  * Si el `numero_cuotas` **NO cambió** (ej. ajuste de tasa o TRM): actualiza cada fila existente de `CuotasDetalle` haciendo `UPDATE` por `(compra, numero_cuota)` dentro de `prisma.$transaction`. Así el Trigger 8 actualiza automáticamente `MovimientosDeudaPersona` sin romper llaves foráneas.
  * Si el `numero_cuotas` **SÍ cambió** o se elimina la compra: dentro de una misma transacción (`prisma.$transaction`), primero elimina los asientos asociados en `MovimientosDeudaPersona` (`WHERE cuota_detalle_id IN (...)`), luego elimina y recrea `CuotasDetalle`, y finalmente ejecuta una actualización sobre `ResponsablesComprasCredito` para que el Trigger 6 (`trg_after_insert_responsable_tc`) regenere limpiamente las cuotas en `MovimientosDeudaPersona`.

### Regla 5: Aislamiento Multi-Tenant (`owner_user_id`) y Eliminación de Tabla `"Usuarios"`
* La antigua tabla `"Usuarios"` de AppSheet fue eliminada (`DROP TABLE`). Toda persona física vive en `"Personas"`.
* Las credenciales de login viven en `"Users"`.
* Todo endpoint autenticado debe extraer el `userId` (`Users.id`) del token JWT mediante un decorador `@CurrentUser()` y filtrar/asignar `owner_user_id = userId` en todas las consultas y creaciones.

### Regla 6: Paridad de Contratos Legacy + Extensibilidad para Angular
* **Rutas Legacy:** Todos los endpoints que ya existen en `conf/routes` y `public/swagger/openapi.yaml` deben conservar exactamente su misma ruta, verbo HTTP, códigos de estado y estructura de payload JSON para que la aplicación Angular actual funcione sin romper ni una sola pantalla al cambiar la URL del backend.
* **Rutas Nuevas (ERP v2):** Las nuevas funcionalidades de las 21 tablas se expondrán bajo rutas limpias RESTful documentadas con `@nestjs/swagger` para autogenerar clientes en Angular.

---

## 3. ARQUITECTURA OBJETIVO EN `./backend-nestjs`

Estructura el proyecto en `./backend-nestjs` siguiendo una arquitectura modular por dominios (Domain-Driven Modules):

```text
backend-nestjs/
├── prisma/
│   └── schema.prisma                         # Esquema introspectado desde Supabase (21 tablas + vistas)
├── src/
│   ├── main.ts                               # Bootstrap, CORS para Angular, ValidationPipe, Swagger
│   ├── app.module.ts                         # Módulo raíz
│   ├── config/
│   │   ├── env.validation.ts                 # Validación de variables de entorno con Joi / Zod
│   │   └── decimal.config.ts                 # Configuración global de Decimal.js
│   ├── prisma/
│   │   ├── prisma.module.ts                  # Módulo global de Prisma
│   │   └── prisma.service.ts                 # Conexión e hooks de cierre limpio
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts     # Extrae el usuario autenticado del JWT
│   │   │   └── public.decorator.ts           # Marca rutas públicas (ej. login, swagger)
│   │   ├── guards/
│   │   │   └── jwt-auth.guard.ts             # Equivalente a JwtFilter.scala y AuthenticatedAction.scala
│   │   ├── interceptors/
│   │   │   └── json-serialization.interceptor.ts # Convierte BigInt y Prisma.Decimal a números JSON
│   │   ├── filters/
│   │   │   └── all-exceptions.filter.ts      # Manejo uniforme de errores HTTP y errores de Prisma
│   │   ├── enums/
│   │   │   └── finance.enums.ts              # Los 18 Enums estandarizados de la BD
│   │   └── utils/
│   │       ├── calculadora-amortizacion.util.ts # Migración exacta de CalculadoraAmortizacion de Scala con Decimal.js
│   │       └── date.util.ts                  # Utilidades de fechas (cortes, fin de mes, YYYY-MM)
│   └── modules/
│       ├── auth/                             # Dominio 1: Users, linked_accounts, Login JWT/OAuth
│       ├── personas/                         # Dominio 1: Golden Record de Personas (Terceros y Familiares)
│       ├── tarjetas/                         # Dominio 2: Tarjetas, pago de extracto (sp_pagar_extracto_tarjeta) y WebScraping
│       ├── compras-credito/                  # Dominio 2: ComprasCredito, CuotasDetalle, Responsables, CSV Upload, USD TRM
│       ├── consultas-pagos/                  # Dominio 2 y 5: ConsultasPagosControlador legacy + Reportes mensuales
│       ├── cuentas-financieras/              # Dominio 3: CuentasFinancieras y Categorias
│       ├── transacciones/                    # Dominio 3: Libro diario de Transacciones (Ingresos, Egresos, Transferencias)
│       ├── notificaciones-correo/            # Dominio 3: Webhook / Ingesta idempotente de correos bancarios
│       ├── gastos-recurrentes/               # Dominio 4: PlantillasRecurrentes, ResponsablesRecurrentes, PeriodosRecurrentes
│       ├── prestamos/                        # Dominio 5: Prestamos, CortesCobro, AprobacionesPrestamos
│       ├── obligaciones-aportes/             # Dominio 5: ObligacionesMes (Carro/Casa), AportesDia, AportesDetalle
│       └── subledger-deudas/                 # Dominio 5: CrucesDeuda, MovimientosDeudaPersona, Abonos y Flujo de Caja
├── test/
│   ├── calculadora-amortizacion.spec.ts      # Tests unitarios migrados de Scala + casos multimoneda
│   ├── compras-credito.service.spec.ts       # Migración exacta de CompraCreditoServicioTest.scala
│   └── e2e/                                  # Pruebas de integración de controladores
├── Dockerfile                                # Multi-stage build ligero con node:22-alpine
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

## 4. ESPECIFICACIÓN DE TRADUCCIÓN DE LA LÓGICA DE SCALA A NESTJS

Antes de implementar los módulos, inspecciona los archivos de Scala en `app/` y aplica estas reglas de traducción exacta:

### 4.1 Autenticación y Seguridad (`AuthController.scala`, `JwtFilter.scala`, `AuthenticatedAction.scala`)
1. Lee `app/controllers/AuthController.scala`, `app/controllers/filters/JwtFilter.scala`, `app/percistencia/UserRepositoriy.scala` y `app/percistencia/UserServiceImpl.scala`.
2. En NestJS (`src/modules/auth`), utiliza `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt` y `bcrypt`.
3. Respeta exactamente la firma del payload JWT (claims como `userId` / `id`, `email`, `role`) y el secreto configurado en variables de entorno (`JWT_SECRET` / `play.http.secret.key`) para que las sesiones activas de Angular sigan siendo válidas.
4. Asegura que las rutas públicas configuradas en `JwtFilter.scala` (como login, registro, healthcheck y swagger) usen el decorador `@Public()`.

### 4.2 Calculadora de Amortización (`CalculadoraAmortizacion` + `CompraCreditoServicio.scala`)
1. Lee el archivo donde está definida `CalculadoraAmortizacion.calcularAmortizacion` en `app/modelo/` y revisa `test/servicios/CompraCreditoServicioTest.scala`.
2. Traduce `calcularAmortizacion` a `src/common/utils/calculadora-amortizacion.util.ts` usando exclusivamente `Decimal` de `decimal.js`:
   * Parámetros:
     * `valorCompra: Decimal`
     * `interesMensualPorcentaje: Decimal` (ej. `2.15` para $2.15\%$)
     * `numeroCuotas: number`
     * `fechaCompra: Date`
     * `cobraInteresPrimeraCuota: boolean`
     * `diaCorteTarjeta?: number | null` (Nuevo: si la tarjeta tiene `dia_corte` configurado en BD, úsalo si aplica; de lo contrario, mantén la regla exacta de Scala: si `fechaCompra.getDate() < 15` el primer pago es al final del mes actual, y si es $\ge 15$ el primer pago es al final del mes siguiente).
   * Por cada cuota $k \in \{1, \dots, N\}$, calcula con `Decimal`:
     * `aporte_capital`, `interes_pagado`, `pago_total`, `saldo_restante`, `fecha_pago`, `estado` y `periodo_facturacion` (`'YYYY-MM'`).

### 4.3 Servicio de Compras de Crédito (`CompraCreditoServicio.scala`)
Traduce todos los métodos de `CompraCreditoServicio.scala` dentro de `ComprasCreditoService` en NestJS usando `prisma.$transaction`:

1. **`save(dto, ownerUserId)`:**
   * Soporta el nuevo modelo multimoneda de `ComprasCredito`:
     * Si no se envía `moneda_original`, por defecto es `'COP'`, `valor_moneda_original = valor_compra`, `tasa_cambio_aplicada = 1.0000`, `trm_confirmada = true`.
     * Si `moneda_original === 'USD'`, calcula `valor_compra = valor_moneda_original.mul(tasa_cambio_aplicada).toDecimalPlaces(2)`.
   * Calcula `fechaPrimerPago` (día $< 15$ $\rightarrow$ fin de mes actual; día $\ge 15$ $\rightarrow$ fin del mes siguiente) y `fechaUltimaCuota = fechaPrimerPago.plusMonths(numeroCuotas - 1)`.
   * Calcula `pagoMensualBase = valorCompra.div(numeroCuotas)`, `interesMensual = pagoMensualBase.mul(interes.div(100))`, `pagoMensualTotal = pagoMensualBase.plus(interesMensual)`.
   * Guarda la cabecera en `"ComprasCredito"` con `owner_user_id = ownerUserId`.
   * Genera la tabla de amortización con `cobraInteresPrimeraCuota = false` y guarda todas las cuotas en `"CuotasDetalle"` incluyendo `periodo_facturacion` (`'YYYY-MM'`).
   * **Importante:** Si el request o flujo posterior asigna responsables en `"ResponsablesComprasCredito"`, insértalos **después** de haber insertado `"CuotasDetalle"` para que el Trigger 6 (`trg_after_insert_responsable_tc`) encuentre las cuotas y cree automáticamente los registros en `"MovimientosDeudaPersona"`.

2. **`recalcularCuotas(compraId, ownerUserId)`:**
   * Verifica si `compraCredito.concepto.toUpperCase().includes('AJUSTE DE INTERES')` para activar `cobraInteresPrimeraCuota = true`.
   * Calcula la nueva tabla de amortización.
   * Actualiza `fecha_ultima_cuota` en `"ComprasCredito"` y sincroniza `"CuotasDetalle"` respetando la **Regla 4** para mantener íntegro el Sub-Ledger `"MovimientosDeudaPersona"`.

3. **`cambioEstado(ownerUserId)`:**
   * Busca las compras en estado `'Pendiente'` (o `'ACTIVA'`) cuya `fecha_ultima_cuota < hoy` y actualiza su estado a `'Pagado'`.

4. **`ajusteInteresTarjetaCredito(tarjetaId, ownerUserId)`:**
   * Busca las compras pendientes de esa tarjeta (`tarjeta = tarjetaId`).
   * En una transacción: cambia `ComprasCredito.estado` a `'Ajuste Interes'`, recalcula la amortización con `cobraInteresPrimeraCuota = true`, y para cada cuota cuya `fecha_pago >= currentDate` asigna `estado = 'Ajuste Interes'`. Sincroniza las cuotas siguiendo la **Regla 4**.

5. **`delete(compraCreditoId, ownerUserId)`:**
   * Lee `DOCUMENTACION_DELETE_UPDATE.md`.
   * Ejecuta dentro de `prisma.$transaction`:
     1. `DELETE FROM "MovimientosDeudaPersona"` donde `cuota_detalle_id` o `responsable_compra_id` pertenezcan a esa compra.
     2. `DELETE FROM "ResponsablesComprasCredito"` donde `compra_credito = compraCreditoId`.
     3. `DELETE FROM "CuotasDetalle"` donde `compra = compraCreditoId`.
     4. `DELETE FROM "ComprasCredito"` donde `id = compraCreditoId AND owner_user_id = ownerUserId`.

6. **`updateCompra(compraCreditoId, dto, ownerUserId)`:**
   * Actualiza los datos en `"ComprasCredito"` y ejecuta `recalcularCuotas`.

7. **Carga Masiva de Compras por CSV (`README_CSV_UPLOAD.md` y `ComprasCreditoControlador.scala`):**
   * Lee `README_CSV_UPLOAD.md` y `ejemplo_compras.csv` para replicar exactamente las columnas esperadas, validaciones de formato y estructura de respuesta al subir un archivo CSV con `@UseInterceptors(FileInterceptor('file'))` y `csv-parse`.

### 4.4 Pagos y Consultas (`PagosServicio.scala` y `ConsultasPagosControlador.scala`)
1. Lee `app/servicios/PagosServicio.scala`, `app/controllers/ConsultasPagosControlador.scala`, `app/percistencia/ConsultaPagosMensuales.scala` y `app/percistencia/PagosRepositorio.scala`.
2. Replica idénticamente los endpoints actuales que agrupan pagos mensuales por responsable (`PagosMensualesReponsable.scala`) y por tarjeta para no romper las vistas actuales de Angular.

### 4.5 Web Scraping de Tasas Bancarias (`WebScrapingServicio.scala` y `TarjetaControlador.scala`)
1. Lee `app/servicios/WebScrapingServicio.scala`.
2. Migra la extracción de tasas de interés desde las URLs de los bancos (`Tarjetas.url_info`) utilizando `axios`/`fetch` + `cheerio` (o el mecanismo equivalente al que usa Scala), convirtiendo las tasas extraídas a `Prisma.Decimal` y actualizando `tasa_interes_compra`, `tasa_interes_avance` y `ultima_actualizacion_tasas` en `"Tarjetas"`.

---

## 5. NUEVAS CAPACIDADES DEL ERP FINANCIERO (EXPLOTACIÓN DE LAS 21 TABLAS DE SUPABASE)

Además de los endpoints legacy migrados 1:1, debes implementar los controladores, servicios y DTOs para los nuevos dominios detallados en `base de datos-documentacion.md`:

### 5.1 Módulo de Tarjetas y Compras Multimoneda (`USD` / `COP`)
* **`PATCH /api/v2/compras-credito/:id/confirmar-trm`:**
  * Recibe `{ nuevaTrm: number, confirmarDefinitivo?: boolean }`.
  * Invoca directamente la función almacenada en PostgreSQL:
    ```sql
    SELECT sp_actualizar_trm_compra_usd($1::int8, $2::numeric(12,4), $3::bool);
    ```
* **`POST /api/v2/tarjetas/:id/pagar-extracto`:**
  * Recibe `{ cuentaOrigenId: number, periodo: string, montoPagado: number }`.
  * Invoca la función almacenada en PostgreSQL:
    ```sql
    SELECT sp_pagar_extracto_tarjeta($1::int8, $2::int8, $3::int8, $4::char(7), $5::numeric(15,2)) AS transaccion_id;
    ```
* **`GET /api/v2/tarjetas/resumen-mensual?periodo=YYYY-MM`:**
  * Ejecuta la consulta **7.3 (Resumen Mensual de Pago por Tarjeta de Crédito: Lo tuyo vs. Lo de terceros + Compras en USD)** de `base de datos-documentacion.md`.

### 5.2 Módulo de Cuentas Financieras, Categorías y Transacciones (`Dominio 3`)
* **`/api/v2/cuentas-financieras`:**
  * CRUD de `"CuentasFinancieras"` (`AHORROS`, `CORRIENTE`, `BILLETERA_DIGITAL`, `EFECTIVO`).
  * Recuerda: `saldo_actual` se inicializa al crear la cuenta y luego es mantenido exclusivamente por el Trigger 2 (`trg_actualizar_saldo_cuenta`).
* **`/api/v2/categorias`:**
  * Listado de categorías del sistema (`owner_user_id IS NULL`) más las categorías personalizadas del usuario (`owner_user_id = userId`), y creación/edición de categorías propias.
* **`/api/v2/transacciones`:**
  * Registro y consulta filtrada (por fechas, cuenta, categoría, tipo y estado) en `"Transacciones"`.
  * Validaciones de negocio en DTO/Servicio:
    * Si `tipo_transaccion === 'EGRESO'` o `'PAGO_TARJETA'`, `cuenta_origen_id` es obligatorio.
    * Si `tipo_transaccion === 'INGRESO'` o `'REEMBOLSO_TERCERO'`, `cuenta_destino_id` es obligatorio.
    * Si `tipo_transaccion === 'TRANSFERENCIA'`, tanto `cuenta_origen_id` como `cuenta_destino_id` son obligatorios y distintos entre sí (una sola fila en `"Transacciones"` actualiza ambas cuentas gracias al Trigger 2).

### 5.3 Módulo de Ingesta Automática de Correos Bancarios (`NotificacionesCorreo`)
* **`POST /api/v2/notificaciones-correo/ingesta`:**
  * Recibe el payload del lector de correos (`external_message_id`, `remitente`, `asunto`, `fecha_correo`, `cuerpo_extraido`, `datos_parseados`).
  * Garantiza idempotencia por `external_message_id` (`ON CONFLICT (external_message_id) DO NOTHING`).
  * Si `datos_parseados.ultimos_4` coincide con `CuentasFinancieras.ultimos_4_digitos`, crea automáticamente la transacción en estado `'PENDIENTE_REVISION'` con `origen_registro = 'EMAIL_AUTO'` y enlaza `transaccion_generada_id`.
* **`PATCH /api/v2/notificaciones-correo/:id/conciliar`:**
  * Permite desde Angular confirmar, categorizar o descartar una transacción detectada por correo (al pasar la transacción a `'CONFIRMADO'`, el Trigger 2 impacta el saldo de la cuenta).

### 5.4 Módulo de Gastos Recurrentes y Pronósticos del Hogar (`Dominio 4`)
* **`/api/v2/plantillas-recurrentes`:**
  * CRUD de `"PlantillasRecurrentes"` y sus participantes en `"ResponsablesRecurrentes"` (ej. Mercado Casa, Energía, Internet, Suscripciones, Cuota Casa).
* **`POST /api/v2/periodos-recurrentes/proyectar?periodo=YYYY-MM`:**
  * Ejecuta la sentencia SQL de la **Sección 6.2.C** de `base de datos-documentacion.md`, que calcula automáticamente el `monto_pronosticado` usando el promedio móvil de los últimos 3 meses pagados cuando `es_monto_variable = true` o el `monto_base_estimado` cuando es fijo.
* **`PATCH /api/v2/periodos-recurrentes/:id/registrar-pago`:**
  * Actualiza `monto_real_pagado`, `estado = 'PAGADO'` (o `'FACTURADO'`), y opcionalmente crea la transacción en `"Transacciones"` o enlaza `compra_credito_pago_id`.
  * Al pasar a `'FACTURADO'` o `'PAGADO'`, el Trigger 7 (`trg_after_update_periodo_recurrente`) carga automáticamente la deuda proporcional a cada participante en `"MovimientosDeudaPersona"`.

### 5.5 Módulo de Préstamos, Cortes de Cobro y Aprobaciones (`Dominio 5`)
* **`/api/v2/cortes-cobro`:**
  * CRUD de `"CortesCobro"` y obtención del corte `'ACTIVO'` según la fecha actual.
* **`/api/v2/prestamos` (Extensión compatible con legacy):**
  * Mantiene los endpoints legacy de `PrestamoControlador.scala` y añade soporte para `direccion_prestamo` (`'POR_COBRAR'` / `'POR_PAGAR'`), `saldo_pendiente`, `metodo`, `corte_id` y listado de `"AprobacionesPrestamos"`.
* **`PATCH /api/v2/prestamos/:id/aprobaciones/:aprobacionId`:**
  * Permite a una persona o al administrador cambiar el estado de su aprobación (`'Aprobado'`, `'Rechazado'`) con comentarios y fecha.

### 5.6 Módulo de Obligaciones Mensuales y Aportes Diarios Carro/Casa (`Dominio 5`)
* **`GET /api/v2/obligaciones-mes` y `GET /api/v2/obligaciones-mes/:id/resumen`:**
  * Consulta directamente la vista calculada `"vw_ResumenObligacionesMes"` para obtener `meta_mensual`, `aporte_total_real`, `restante_real`, `aportado_directo_responsable`, `aportado_por_cruces` y `estado_calculado`.
* **`GET /api/v2/obligaciones-mes/:id/aportes-dia`:**
  * Consulta la vista `"vw_AportesDiaResumen"` junto con el desglose de `"AportesDetalle"` y los datos de `"Personas"`.
* **`POST /api/v2/obligaciones-mes/:id/aportes-dia`:**
  * Busca o crea el registro en `"AportesDia"` para `(obligacion_mes_id, fecha)` e inserta los ítems en `"AportesDetalle"`.
  * **Nota crítica:** El Trigger 3 (`trg_before_insert_aporte_detalle`) detecta automáticamente si `persona_id` es un tercero (ej. Carlos Andrés, Alicia o Jeimmy) y crea el préstamo por cruce, las aprobaciones y el cargo en el Sub-Ledger sin que NestJS tenga que hacerlo manualmente.

### 5.7 Módulo Sub-Ledger de Deudas, Cruces Triangulares y Flujo de Caja (`Dominio 5`)
* **`POST /api/v2/cruces-deuda`:**
  * Inserta en `"CrucesDeuda"` (`persona_que_abona_id`, `persona_que_asume_deuda_id`, `monto`, `prestamo_destino_id`, `periodo_recurrente_destino_id`, `concepto`). El Trigger 5 genera los dos asientos (`-1` y `+1`) en `"MovimientosDeudaPersona"`.
* **`POST /api/v2/personas/:id/abonar`:**
  * Invoca la función almacenada `sp_registrar_abono_persona` de PostgreSQL:
    ```sql
    SELECT sp_registrar_abono_persona($1::int8, $2::int8, $3::int8, $4::numeric(15,2), $5::char(7), $6::varchar, $7::int8) AS movimiento_id;
    ```
* **`GET /api/v2/subledger/estado-cuenta?periodo=YYYY-MM`:**
  * Ejecuta la consulta **7.1 (Estado de Cuenta Consolidado por Persona a Fin de Mes)** de `base de datos-documentacion.md`.
* **`GET /api/v2/subledger/personas/:personaId/extracto?periodo=YYYY-MM`:**
  * Ejecuta la consulta **7.2 (Extracto Detallado de una Persona en un Corte o Mes)** de `base de datos-documentacion.md`.
* **`GET /api/v2/dashboard/flujo-caja?periodo=YYYY-MM`:**
  * Ejecuta la consulta **7.4 (Tablero de Pronóstico de Flujo de Caja Mensual: Ingresos vs. Tarjetas + Recurrentes + Obligaciones)** de `base de datos-documentacion.md`.

---

## 6. CATÁLOGO OBLIGATORIO DE ENUMS EN TYPESCRIPT (`src/common/enums/finance.enums.ts`)

Implementa exactamente estos Enums para validar todos los DTOs con `class-validator` (`@IsEnum(...)`):

```typescript
export enum TipoCuentaFinanciera {
  AHORROS = 'AHORROS',
  CORRIENTE = 'CORRIENTE',
  BILLETERA_DIGITAL = 'BILLETERA_DIGITAL',
  EFECTIVO = 'EFECTIVO',
}

export enum TipoCategoria {
  INGRESO = 'INGRESO',
  EGRESO = 'EGRESO',
  AMBOS = 'AMBOS',
}

export enum TipoTransaccion {
  INGRESO = 'INGRESO',
  EGRESO = 'EGRESO',
  TRANSFERENCIA = 'TRANSFERENCIA',
  PAGO_TARJETA = 'PAGO_TARJETA',
  PAGO_PRESTAMO = 'PAGO_PRESTAMO',
  REEMBOLSO_TERCERO = 'REEMBOLSO_TERCERO',
}

export enum OrigenRegistro {
  MANUAL = 'MANUAL',
  EMAIL_AUTO = 'EMAIL_AUTO',
  MIGRACION = 'MIGRACION',
}

export enum EstadoTransaccion {
  PENDIENTE_REVISION = 'PENDIENTE_REVISION',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}

export enum EstadoNotificacionCorreo {
  PENDIENTE = 'PENDIENTE',
  CONCILIADO = 'CONCILIADO',
  IGNORADO = 'IGNORADO',
  ERROR = 'ERROR',
}

export enum FrecuenciaRecurrente {
  SEMANAL = 'SEMANAL',
  QUINCENAL = 'QUINCENAL',
  MENSUAL = 'MENSUAL',
  ANUAL = 'ANUAL',
}

export enum EstadoPeriodoRecurrente {
  PROYECTADO = 'PROYECTADO',
  FACTURADO = 'FACTURADO',
  PAGADO = 'PAGADO',
  OMITIDO = 'OMITIDO',
}

export enum DireccionPrestamo {
  POR_COBRAR = 'POR_COBRAR',
  POR_PAGAR = 'POR_PAGAR',
}

export enum EstadoPrestamo {
  PENDIENTE = 'Pendiente',
  PAGADO = 'Pagado',
  ANULADO = 'Anulado',
}

export enum MetodoPrestamo {
  NEQUI = 'Nequi',
  FISICO = 'Fisico',
  PAGO_FERNANDO = 'Pago Fernando',
  PRESTAMO_FERNANDO = 'Prestamo Fernando',
  DOMICILIO = 'Domicilio',
  OTROS = 'Otros',
}

export enum EstadoAprobacion {
  PENDIENTE = 'Pendiente',
  APROBADO = 'Aprobado',
  RECHAZADO = 'Rechazado',
}

export enum EstadoCorte {
  PASADO = 'PASADO',
  ACTIVO = 'ACTIVO',
  FUTURO = 'FUTURO',
}

export enum TipoObligacionMes {
  CUOTA_CARRO = 'CUOTA_CARRO',
  CUOTA_CASA = 'CUOTA_CASA',
  OTRO = 'OTRO',
}

export enum EstadoObligacionMes {
  ABIERTO = 'ABIERTO',
  COMPLETADO = 'COMPLETADO',
}

export enum MetodoAporte {
  FISICO = 'Fisico',
  BANCOLOMBIA = 'Bancolombia',
  NEQUI = 'Nequi',
  CARRERA = 'Carrera',
  USO_CARRO = 'Uso Carro',
  PRESTAMO = 'Prestamo',
  PAGO_MENSUAL = 'Pago Mensual',
  OTRO = 'Otro',
}

export enum TipoMovimientoDeuda {
  CARGO_CUOTA_TC = 'CARGO_CUOTA_TC',
  CARGO_GASTO_COMPARTIDO = 'CARGO_GASTO_COMPARTIDO',
  CARGO_PRESTAMO_DIRECTO = 'CARGO_PRESTAMO_DIRECTO',
  CARGO_CRUCE_DEUDA = 'CARGO_CRUCE_DEUDA',
  ABONO_PAGO_RECIBIDO = 'ABONO_PAGO_RECIBIDO',
  ABONO_APORTE_DIARIO = 'ABONO_APORTE_DIARIO',
  ABONO_CRUCE_DEUDA = 'ABONO_CRUCE_DEUDA',
}

export enum EstadoMovimientoDeuda {
  PROYECTADO = 'PROYECTADO',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}
```

---

## 7. PLAN DE EJECUCIÓN PASO A PASO PARA EL AGENTE DE IA

Ejecuta la migración siguiendo estrictamente estas **6 Fases secuenciales**. No avances a la siguiente fase hasta que el checkpoint de verificación de la fase actual pase sin errores.

### FASE 0: Auditoría del Código Scala y Lectura de Contratos
1. Lee completamente `conf/routes`, `public/swagger/openapi.yaml`, `base de datos-documentacion.md`, `DOCUMENTACION_DELETE_UPDATE.md`, `DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md` y `README_CSV_UPLOAD.md`.
2. Lee todos los archivos `.scala` en `app/controllers/`, `app/modelo/`, `app/percistencia/`, `app/servicios/` y `test/`.
3. Genera un archivo `./backend-nestjs/MIGRATION_INVENTORY.md` listando cada ruta de `conf/routes`, su payload de entrada/salida y el controlador de NestJS que la atenderá.

### FASE 1: Inicialización del Proyecto NestJS y Capa de Datos (Prisma + Supabase)
1. Crea el proyecto en `./backend-nestjs` e instala las dependencias necesarias:
   * `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/jwt`, `@nestjs/passport`, `@nestjs/swagger`
   * `passport`, `passport-jwt`, `bcrypt`, `class-validator`, `class-transformer`
   * `@prisma/client`, `prisma`, `decimal.js`, `csv-parse`, `cheerio`, `axios`
   * Tipos de desarrollo: `@types/node`, `@types/express`, `@types/passport-jwt`, `@types/bcrypt`, `@types/multer`.
2. Configura `prisma/schema.prisma` con las **21 tablas exactas** especificadas en la Sección 3 de `base de datos-documentacion.md` (o ejecuta `npx prisma db pull` si las credenciales de Supabase están disponibles en `.env` y ajusta las relaciones).
3. Ejecuta `npx prisma generate` y verifica que el cliente Prisma se genere sin errores.
4. Implementa `PrismaModule`, `PrismaService`, `JsonSerializationInterceptor` (para `BigInt` y `Decimal`), `AllExceptionsFilter` y `JwtAuthGuard`.
5. **Checkpoint Fase 1:** `npm run build` debe compilar con $0$ errores de TypeScript.

### FASE 2: Núcleo Financiero y Pruebas Unitarias (`CalculadoraAmortizacion` + `Decimal.js`)
1. Traduce `CalculadoraAmortizacion` a `src/common/utils/calculadora-amortizacion.util.ts` usando `Decimal.js`.
2. Traduce `test/servicios/CompraCreditoServicioTest.scala` a Jest (`test/compras-credito.service.spec.ts` y `test/calculadora-amortizacion.spec.ts`).
3. Ejecuta `npm test` y verifica que los resultados de las cuotas, intereses, saldos restantes y fechas de pago coincidan al centavo con los tests originales de Scala.
4. **Checkpoint Fase 2:** Suite de pruebas unitarias financieras pasando al $100\%$.

### FASE 3: Migración 1:1 de los 10 Controladores y Servicios Legacy
1. Implementa los módulos que reemplazan exactamente a los controladores de Play Framework respetando las rutas de `conf/routes`:
   * `AuthController` (`/login`, `/register`, etc.)
   * `PersonaControlador`
   * `TarjetaControlador` (incluyendo el servicio de Web Scraping de tasas)
   * `ComprasCreditoControlador` (incluyendo `save`, `updateCompra`, `delete`, `recalcularCuotas`, `cambioEstado`, `ajusteInteresTarjetaCredito` y subida de CSV)
   * `CuotaDetalleControlador`
   * `ResponsableCompraCreditoControlador` (respetando las reglas de `DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md`)
   * `PrestamoControlador`
   * `ConsultasPagosControlador`
   * `HomeController` y `SwaggerController`
2. **Checkpoint Fase 3:** `npm run build` y `npm test` sin errores. Verifica que todas las rutas de `conf/routes` existan en los controladores de NestJS con los mismos paths y métodos HTTP.

### FASE 4: Implementación de los Nuevos Módulos del ERP Financiero (Supabase v2)
1. Implementa los controladores, servicios y DTOs bajo el prefijo `/api/v2/...` para todas las nuevas funcionalidades de las 21 tablas:
   * Confirmación de TRM en dólares (`sp_actualizar_trm_compra_usd`) y pago de extracto de tarjeta (`sp_pagar_extracto_tarjeta`).
   * `CuentasFinancierasModule`, `CategoriasModule` y `TransaccionesModule`.
   * `NotificacionesCorreoModule` (ingesta idempotente por `external_message_id` y conciliación).
   * `GastosRecurrentesModule` (`PlantillasRecurrentes`, `ResponsablesRecurrentes`, proyección automática con promedio móvil de 3 meses en `PeriodosRecurrentes`).
   * `CortesCobro` y `AprobacionesPrestamos` integrados en `PrestamosModule`.
   * `ObligacionesAportesModule` (`ObligacionesMes`, `AportesDia`, `AportesDetalle`, vistas `vw_ResumenObligacionesMes` y `vw_AportesDiaResumen`).
   * `SubledgerDeudasModule` (`CrucesDeuda`, `sp_registrar_abono_persona`, estado de cuenta consolidado 7.1, extracto detallado 7.2, resumen de tarjetas 7.3 y dashboard de flujo de caja 7.4).
2. **Checkpoint Fase 4:** `npm run build` sin errores y cobertura de pruebas sobre los nuevos servicios.

### FASE 5: Integración con Angular (CORS, OpenAPI/Swagger y Generación de Clientes)
1. Configura en `src/main.ts`:
   * `app.enableCors()` permitiendo los orígenes de desarrollo (`http://localhost:4200`) y producción de la app Angular, con soporte de credenciales y headers `Authorization`.
   * `DocumentBuilder` de `@nestjs/swagger` con `.addBearerAuth()` exponiendo la interfaz en `/api/docs` y el documento JSON en `/api/docs-json` (además de mantener la ruta legacy de Swagger si Angular o herramientas externas la consultan).
2. Agrega en `package.json` un script `"openapi:export"` para generar el archivo `openapi-generated.json`, listo para que el proyecto de Angular pueda autogenerar servicios e interfaces con `@openapitools/openapi-generator-cli`.

### FASE 6: Dockerización Optimizada para AWS y Verificación Final
1. Crea un `Dockerfile` multi-stage en `./backend-nestjs/Dockerfile` basado en `node:22-alpine` que:
   * Ejecute `npx prisma generate` y `npm run build` en la etapa `builder`.
   * Copie únicamente `dist/`, `node_modules/` de producción y `prisma/` a la imagen final ligera.
   * Exponga el mismo puerto (`9000` por defecto o `process.env.PORT`) que usaba la aplicación de Play Framework en AWS para que el despliegue sea un reemplazo directo (*drop-in replacement*).
2. Crea un archivo `./backend-nestjs/.env.example` documentando `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `PORT` y `CORS_ORIGINS`.

---

## 8. CRITERIOS DE ACEPTACIÓN (DEFINITION OF DONE)

Antes de dar por finalizada tu tarea como Agente de IA, verifica que se cumplan todos los puntos de esta lista:

- [ ] El directorio original de Scala permanece intacto (no se borraron ni alteraron archivos fuera de `./backend-nestjs`).
- [ ] Las 21 tablas y las 2 vistas de `base de datos-documentacion.md` están correctamente mapeadas en `./backend-nestjs/prisma/schema.prisma`.
- [ ] Cero uso de `number` nativo para cálculos financieros; toda operación monetaria usa `Decimal.js` / `Prisma.Decimal`.
- [ ] El `JsonSerializationInterceptor` convierte `BigInt` y `Prisma.Decimal` de forma segura en todas las respuestas JSON hacia Angular.
- [ ] Todos los endpoints existentes en `conf/routes` de Scala tienen su equivalente exacto en NestJS (misma URL, verbo HTTP, query params y estructura JSON).
- [ ] Todas las consultas SQL avanzadas (Secciones 7.1, 7.2, 7.3 y 7.4 de `base de datos-documentacion.md`) y las 3 funciones RPC (`sp_actualizar_trm_compra_usd`, `sp_pagar_extracto_tarjeta`, `sp_registrar_abono_persona`) están implementadas y tipadas.
- [ ] `npm run build` y `npm run test` dentro de `./backend-nestjs` finalizan con **0 errores** y **100% de tests aprobados**.