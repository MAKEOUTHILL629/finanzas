# 🏗️ Arquitectura y Análisis de la Aplicación Finanzas

## 📋 Tabla de Contenidos
1. [Stack Tecnológico](#stack-tecnológico)
2. [Arquitectura General](#arquitectura-general)
3. [Estructura de Capas](#estructura-de-capas)
4. [Funcionalidades Implementadas](#funcionalidades-implementadas)
5. [Configuración y Deployment](#configuración-y-deployment)
6. [Seguridad](#seguridad)
7. [Aspectos de Mejora](#aspectos-de-mejora)

---

## 🔧 Stack Tecnológico

### Backend Framework
- **Play Framework 3.0.4** (Scala 2.13.16)
- Framework web reactivo para aplicaciones escalables
- Soporte nativo para programación asíncrona con Futures

### Lenguaje
- **Scala 2.13.16**
- Lenguaje funcional y orientado a objetos
- Tipado estático con inferencia de tipos

### Base de Datos
- **PostgreSQL** (Supabase Cloud)
- Conexión mediante JDBC
- Pool de conexiones configurado con 9 threads

### Librerías Principales
```scala
libraryDependencies += guice                                    // Inyección de dependencias
libraryDependencies += jdbc                                     // Conectividad DB
libraryDependencies += "org.postgresql" % "postgresql" % "42.7.3"
libraryDependencies += "com.github.jwt-scala" %% "jwt-play-json" % "10.0.4"  // JWT
libraryDependencies += "org.mindrot" % "jbcrypt" % "0.4"       // Hash passwords
libraryDependencies += "org.apache.commons" % "commons-csv" % "1.10.0"      // CSV
```

### Herramientas de Build
- **SBT (Scala Build Tool)**
- Sistema de compilación incremental
- Gestión de dependencias y plugins

---

## 🏛️ Arquitectura General

La aplicación sigue una **arquitectura en capas (layered architecture)** con separación clara de responsabilidades:

```
┌─────────────────────────────────────────────┐
│          CAPA DE PRESENTACIÓN               │
│         (Controllers + Routes)              │
│  - ComprasCreditoControlador                │
│  - AuthController                           │
│  - TarjetaControlador                       │
│  - PersonaControlador, etc.                 │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          CAPA DE SEGURIDAD                  │
│      (Filters + Actions)                    │
│  - JwtFilter (Global)                       │
│  - AuthenticatedAction (Endpoints)          │
│  - CORS, CSRF disabled                      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          CAPA DE LÓGICA DE NEGOCIO          │
│            (Servicios)                      │
│  - CompraCreditoServicio                    │
│  - PagosServicio                            │
│  - UserServiceImpl                          │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          CAPA DE PERSISTENCIA               │
│           (Repositorios)                    │
│  - CompraCreditoRepositorio                 │
│  - CuotaDetalleRepositorio                  │
│  - ResponsablesCompraCreditoRepositorio     │
│  - TarjetaRepositorio, PersonaRepositorio   │
│  - UserRepository                           │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│            BASE DE DATOS                    │
│            PostgreSQL                       │
│         (Supabase Cloud)                    │
└─────────────────────────────────────────────┘
```

---

## 📦 Estructura de Capas

### 1️⃣ **Capa de Modelo (app/modelo/)**
Contiene las clases de dominio (case classes) que representan entidades:

```scala
// Entidades principales
- CompraCredito        // Compras a crédito
- CuotaDetalle        // Detalle de cuotas de amortización
- ResponsableCompraCredito  // Personas responsables de pagar
- Persona             // Usuarios/responsables
- TarjetaModelo       // Tarjetas de crédito
- Prestamo            // Préstamos
- User                // Usuarios del sistema (autenticación)

// Objetos de cálculo
- CalculadoraAmortizacion  // Lógica de cálculo de amortización
```

**Características:**
- Inmutabilidad con `case class`
- Representación 1:1 con tablas de base de datos
- Incluye lógica de cálculo financiero (amortización)

### 2️⃣ **Capa de Persistencia (app/percistencia/)**
Repositorios que manejan el acceso a datos:

```scala
- CompraCreditoRepositorio
  ├─ list()                    // Listar compras con responsables
  ├─ get(id)                   // Obtener compra por ID
  ├─ save(compra)              // Guardar nueva compra
  ├─ update(compra)            // Actualizar compra
  ├─ delete(id)                // Eliminar compra
  ├─ listByEstadoPendiente()   // Filtrar por estado
  └─ listByEstadoPendienteTarjeta(tarjetaId)

- CuotaDetalleRepositorio
  ├─ save(cuota)
  ├─ saveBatch(cuotas)         // Inserción masiva
  ├─ deleteByCompra(compraId)  // Eliminar cuotas de una compra
  └─ listByCompra(compraId)

- ResponsablesCompraCreditoRepositorio
  ├─ save(responsable)
  ├─ update(responsable)       // Actualizar responsable
  ├─ delete(id)                // Eliminar responsable
  ├─ deleteByCompraCredito(id) // Eliminar todos los responsables
  └─ listByCompraCredito(id)
```

**Patrón de Diseño:**
- **Repository Pattern**: Abstracción del acceso a datos
- **Connection pooling**: Gestión eficiente de conexiones
- **Prepared Statements**: Prevención de SQL Injection
- **Using pattern**: Cierre automático de recursos

**Ejemplo de código seguro:**
```scala
def save(compra: CompraCredito): Future[Int] = Future {
  db.withConnection { conn =>
    val sql = "INSERT INTO ... VALUES (?, ?, ?)"
    using(conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) { statement =>
      statement.setString(1, compra.concepto)
      statement.setFloat(2, compra.valorCompra)
      // ... prevención de SQL injection
    }
  }
}(databaseExecutionContext)
```

**Contexto de Ejecución:**
```scala
class DatabaseExecutionContext
```
- Thread pool dedicado para operaciones de BD
- 9 threads configurados (ver application.conf)
- Evita bloquear el thread pool principal del servidor

### 3️⃣ **Capa de Servicios (app/servicios/)**
Contiene la lógica de negocio y orquestación:

#### **CompraCreditoServicio**
```scala
- save(compra)           // Crear compra + calcular cuotas
  └─ calcularAmortizacion()
  └─ guardar cuotas en lote

- updateCompra(compra)   // Actualizar + recalcular cuotas
  └─ update en repositorio
  └─ recalcularCuotas()

- delete(id)             // Eliminar en cascada
  └─ eliminar responsables
  └─ eliminar cuotas
  └─ eliminar compra

- recalcularCuotas(compra)
  └─ Calcular tabla de amortización
  └─ Eliminar cuotas anteriores
  └─ Insertar nuevas cuotas

- cambioEstado()         // Job para actualizar estados
- ajusteInteresTarjetaCredito(tarjetaId)
```

**Lógica Financiera:**
- Cálculo de primera cuota según fecha de compra (día 15 o fin de mes)
- Cálculo de amortización con interés mensual
- Manejo de ajustes de interés
- Sistema de cuotas con:
  - Aporte a capital
  - Interés pagado
  - Saldo restante
  - Fecha de pago

#### **PagosServicio**
```scala
- Cálculo de pagos mensuales por tarjeta
- Distribución de pagos entre responsables
- Generación de reportes de pagos
```

### 4️⃣ **Capa de Controladores (app/controllers/)**
Manejo de requests HTTP y respuestas JSON:

#### **ComprasCreditoControlador**
```scala
✅ GET  /api/compras-credito                  // Listar todas
✅ GET  /api/compras-credito/detalle/:id      // Detalle de compra
✅ POST /api/compras-credito                  // Crear nueva compra
✅ PUT  /api/compras-credito                  // Actualizar compra
✅ DELETE /api/compras-credito/:id            // Eliminar compra
✅ POST /api/compras-credito/upload-csv       // Carga masiva CSV
✅ POST /api/recalcular-compra-credito        // Recalcular cuotas
✅ GET  /api/tarjetas/pagos                   // Pagos mensuales
✅ POST /api/compras-credito/pagar-productos  // Pagar productos
✅ POST /api/compras-credito/ajustar-interes-compras/:id
```

**Características del CSV Upload:**
- Detección automática de delimitador (`,` o `;`)
- Soporte para decimales con punto o coma
- Múltiples formatos de fecha (ISO, europeo, US)
- Encabezados insensibles a mayúsculas
- Búsqueda de tarjetas por ID o franquicia
- Validaciones detalladas con respuesta en CSV
- Procesamiento asíncrono

#### **ResponsableCompraCreditoControlador**
```scala
✅ GET  /api/compras-credito/:id/responsables     // Listar por compra
✅ POST /api/compras-credito/responsables         // Crear responsable
✅ PUT  /api/compras-credito/responsables         // Actualizar responsable
✅ DELETE /api/compras-credito/responsables/:id   // Eliminar responsable
```

#### **AuthController**
```scala
✅ POST /api/auth/login                    // Login con email/password
✅ POST /api/auth/register                 // Registro de usuario
✅ GET  /api/auth/callback/:provider       // OAuth callback
✅ POST /api/auth/logout                   // Logout
✅ GET  /api/auth/token-is-valid           // Validar token JWT
```

**Otros Controladores:**
- TarjetaControlador
- PersonaControlador
- PrestamoControlador
- CuotaDetalleControlador
- ConsultasPagosControlador

### 5️⃣ **Capa de Seguridad**

#### **JwtFilter (Global)**
Filtro HTTP global que intercepta todas las requests:

```scala
class JwtFilter extends Filter
```

**Funcionalidad:**
- ✅ Valida JWT en header `Authorization: Bearer <token>`
- ✅ Rutas excluidas (públicas):
  - `/api/auth/login`
  - `/api/auth/register`
  - `/api/auth/callback/*`
  - `/api/auth/token-is-valid`
- ✅ Permite requests OPTIONS (CORS preflight)
- ✅ Aplica solo a rutas `/api/*`
- ✅ Retorna 401 Unauthorized si token inválido

**Configuración:**
```scala
// application.conf
play.http.secret.key = "..." // Clave secreta para firmar JWT
jwt.expiration = 60000       // Expiración en segundos
```

#### **AuthenticatedAction**
ActionBuilder para proteger endpoints específicos:

```scala
class AuthenticatedAction extends ActionBuilderImpl
```

**Uso:**
```scala
def protectedEndpoint = authenticatedAction.async { request =>
  // Solo se ejecuta si el token es válido
}
```

**Seguridad Implementada:**
- ✅ Hash de contraseñas con BCrypt
- ✅ JWT con algoritmo HS256
- ✅ Tokens con expiración
- ✅ CSRF deshabilitado (API REST)
- ⚠️ CORS no configurado (mejora necesaria)

---

## 🎯 Funcionalidades Implementadas

### 1. **Gestión de Compras a Crédito**
- ✅ CRUD completo (Create, Read, Update, Delete)
- ✅ Carga masiva por CSV (multiidioma)
- ✅ Cálculo automático de cuotas
- ✅ Sistema de amortización
- ✅ Recálculo de cuotas
- ✅ Ajuste de intereses por tarjeta
- ✅ Cambio automático de estado (pendiente → pagado)

### 2. **Gestión de Responsables**
- ✅ Asignar múltiples responsables por compra
- ✅ Porcentaje de pago por responsable
- ✅ CRUD de responsables
- ✅ Distribución de pagos

### 3. **Gestión de Tarjetas**
- ✅ Listar tarjetas
- ✅ Balance por tarjeta
- ✅ Pagos mensuales por tarjeta
- ✅ Detalle de pagos

### 4. **Gestión de Personas**
- ✅ CRUD de personas
- ✅ Asociación con responsables

### 5. **Gestión de Préstamos**
- ✅ Crear préstamos
- ✅ Listar préstamos

### 6. **Sistema de Autenticación**
- ✅ Login con email/password
- ✅ Registro de usuarios
- ✅ JWT tokens
- ✅ OAuth callbacks (preparado)
- ✅ Validación de tokens

### 7. **Consultas y Reportes**
- ✅ Pagos mensuales por persona
- ✅ Detalle de pagos por responsable
- ✅ Balance de tarjetas
- ✅ Cuotas detalladas por compra

---

## ⚙️ Configuración y Deployment

### **application.conf**
```hocon
# Base de datos
db.default.driver = org.postgresql.Driver
db.default.url = "jdbc:postgresql://......supabase.com:6543/postgres?prepareThreshold=0"
db.default.username = .............
db.default.password = .....

# Seguridad
play.filters.disabled += play.filters.csrf.CSRFFilter
play.http.filters = "controllers.filters.Filters"
play.http.secret.key = "..."
jwt.expiration = 60000

# Thread pool de base de datos
database.dispatcher {
  executor = "thread-pool-executor"
  throughput = 1
  thread-pool-executor {
    fixed-pool-size = 9
  }
}
```

### **Dockerfile**
Multi-stage build para optimizar tamaño de imagen:

```dockerfile
# Stage 1: Build
FROM openjdk:11
RUN apt-get update && apt-get install -y sbt
WORKDIR /app
COPY . .
RUN sbt clean compile stage

# Stage 2: Runtime
FROM openjdk:11-jre-slim
WORKDIR /app
COPY --from=build /app/target/universal/stage/ .
COPY conf/ conf/
EXPOSE 9000
ENV JAVA_OPTS="-Xmx512m -Xms256m"
CMD ["./bin/finanzas"]
```

**Características:**
- Imagen final ligera (JRE en lugar de JDK)
- Optimización de memoria con JAVA_OPTS
- Puerto 9000 expuesto
- Configuración externa con `application.docker.conf`

### **Build Configuration**
```scala
// build.sbt
name := "finanzas"
organization := "com.makeouthill"
version := "1.0-SNAPSHOT"
scalaVersion := "2.13.16"
```

```scala
// project/plugins.sbt
addSbtPlugin("org.playframework" % "sbt-plugin" % "3.0.4")
```

---

## 🛡️ Seguridad

### ✅ **Aspectos Bien Implementados**

1. **Prepared Statements**
   - Todas las queries usan PreparedStatement
   - Prevención de SQL Injection

2. **Hash de Contraseñas**
   - BCrypt con salt automático
   - Nunca se almacenan passwords en texto plano

3. **JWT Tokens**
   - Firma con HS256
   - Expiración configurable
   - Validación en cada request

4. **Inyección de Dependencias**
   - Uso de Guice para IoC
   - Evita acoplamiento fuerte

### ⚠️ **Riesgos de Seguridad**

1. **Credenciales en Código**
   ```scala
   // ❌ CRÍTICO: Credenciales en application.conf
   db.default.password = 1PXsB0979HEKaG1j
   play.http.secret.key = "..."
   ```
   **Solución:** Usar variables de entorno

2. **Clave JWT Hardcodeada**
   - La clave secreta está en el código fuente
   - Debería estar en variable de entorno

3. **Sin HTTPS Obligatorio**
   - No hay configuración de SSL/TLS
   - Tokens pueden interceptarse

4. **Sin Rate Limiting**
   - Vulnerable a ataques de fuerza bruta
   - No hay límite de intentos de login

5. **CSRF Deshabilitado Globalmente**
   - Aunque es común en APIs REST, limita opciones futuras

---

## 🚀 Aspectos de Mejora

### 1️⃣ **CRÍTICO - Seguridad**

#### **A. Externalizar Credenciales**
```scala
// ❌ Actual
db.default.password = "password_hardcoded"

// ✅ Mejorado
db.default.password = ${?DATABASE_PASSWORD}
play.http.secret.key = ${?JWT_SECRET_KEY}
```

#### **B. Implementar HTTPS**
```hocon
play.server.https {
  port = 9443
  keyStore = ${?KEY_STORE_PATH}
  keyStorePassword = ${?KEY_STORE_PASSWORD}
}
```

#### **C. Rate Limiting**
```scala
// Agregar librería
libraryDependencies += "com.github.andyglow" %% "play-throttle" % "x.x.x"
```

### 2️⃣ **ALTO - Arquitectura y Código**

#### **A. Implementar ORM (Slick)**
**Problema actual:** SQL manual, propenso a errores

```scala
// ❌ Actual
val sql = "SELECT * FROM ComprasCredito WHERE id = ?"
statement.setInt(1, id)

// ✅ Con Slick
comprasCredito.filter(_.id === id).result.headOption
```

**Beneficios:**
- Queries tipadas en tiempo de compilación
- Composición de queries
- Migraciones automáticas
- Menor código boilerplate

#### **B. Validación de Datos**
**Problema:** Validación mínima o tardía

```scala
// Agregar librería de validación
libraryDependencies += "com.wix" %% "accord-core" % "0.7.6"

// Ejemplo
case class CompraCredito(...) {
  require(valorCompra > 0, "Valor debe ser mayor a 0")
  require(numeroCuotas > 0, "Número de cuotas debe ser mayor a 0")
}
```

#### **C. Manejo de Errores Unificado**
**Problema:** Manejo inconsistente de excepciones

```scala
// Crear ADT para errores
sealed trait AppError
case class NotFoundError(message: String) extends AppError
case class ValidationError(fields: Map[String, String]) extends AppError
case class DatabaseError(cause: Throwable) extends AppError

// Handler global
class ErrorHandler extends HttpErrorHandler {
  def onServerError(request, exception) = // ...
}
```

#### **D. Logging Estructurado**
```scala
// Agregar librería
libraryDependencies += "ch.qos.logback" % "logback-classic" % "1.4.11"
libraryDependencies += "net.logstash.logback" % "logstash-logback-encoder" % "7.4"

// Uso
logger.info("Compra creada", "compraId" -> id, "userId" -> userId)
```

### 3️⃣ **MEDIO - Testing**

#### **A. Tests Unitarios**
```scala
// test/servicios/CompraCreditoServicioSpec.scala
class CompraCreditoServicioSpec extends PlaySpec with MockitoSugar {
  "CompraCreditoServicio" should {
    "calcular correctamente las cuotas" in {
      // Test de cálculo de amortización
    }
  }
}
```

#### **B. Tests de Integración**
```scala
class ComprasCreditoIntegrationSpec extends PlaySpec with GuiceOneAppPerTest {
  "POST /api/compras-credito" should {
    "crear una compra exitosamente" in {
      // Test con base de datos real
    }
  }
}
```

### 4️⃣ **MEDIO - Performance**

#### **A. Caché**
```scala
libraryDependencies += "com.github.cb372" %% "scalacache-caffeine" % "1.0.0"

// Cachear listado de tarjetas
implicit val cache: Cache[List[Tarjeta]] = CaffeineCache[List[Tarjeta]]

def listTarjetas(): Future[List[Tarjeta]] = cachingF("tarjetas")(ttl = 1.hour) {
  tarjetaRepositorio.list()
}
```

#### **B. Paginación**
**Problema:** Todas las queries traen todos los registros

```scala
// ❌ Actual
def list(): Future[Seq[CompraCredito]]

// ✅ Con paginación
def list(page: Int = 1, pageSize: Int = 20): Future[Page[CompraCredito]]
```

#### **C. Índices en Base de Datos**
```sql
-- Agregar índices para queries frecuentes
CREATE INDEX idx_compras_credito_estado ON "ComprasCredito"(estado);
CREATE INDEX idx_compras_credito_tarjeta ON "ComprasCredito"(tarjeta);
CREATE INDEX idx_cuotas_detalle_compra ON "CuotasDetalle"(compra);
CREATE INDEX idx_responsables_compra ON "ResponsablesComprasCredito"(compra_credito);
```

### 5️⃣ **BAJO - Funcionalidades**

#### **A. Documentación de API (Swagger/OpenAPI)**
```scala
libraryDependencies += "org.webjars" % "swagger-ui" % "4.15.5"
libraryDependencies += "io.swagger" %% "swagger-play2" % "4.0.0"
```

#### **B. Health Check Endpoint**
```scala
def health = Action {
  // Verificar conexión a DB, servicios externos, etc.
  Ok(Json.obj("status" -> "UP", "database" -> "connected"))
}
```

#### **C. Métricas y Monitoring**
```scala
libraryDependencies += "io.dropwizard.metrics" % "metrics-core" % "4.2.19"
libraryDependencies += "com.kenshoo" %% "metrics-play" % "2.7.3_0.8.2"
```

#### **D. CORS Configuration**
```scala
play.filters.cors {
  allowedOrigins = ["http://localhost:3000", "https://app.example.com"]
  allowedHttpMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  allowedHttpHeaders = ["Accept", "Content-Type", "Authorization"]
}
```

### 6️⃣ **BAJO - DevOps**

#### **A. CI/CD Pipeline**
```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run tests
        run: sbt test
      - name: Build Docker image
        run: docker build -t finanzas-app .
```

#### **B. Variables de Entorno**
```bash
# .env.example
DATABASE_URL=jdbc:postgresql://...
DATABASE_USER=postgres
DATABASE_PASSWORD=changeme
JWT_SECRET_KEY=your-secret-key-here
JWT_EXPIRATION=3600
```

#### **C. Docker Compose para Desarrollo**
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: finanzas
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
  
  app:
    build: .
    ports:
      - "9000:9000"
    depends_on:
      - postgres
    environment:
      DATABASE_URL: jdbc:postgresql://postgres:5432/finanzas
```

---

## 📊 Modelo de Datos

### **Diagrama de Relaciones**

```
┌────────────────┐
│    Usuarios    │
│  (User)        │
└────────────────┘

┌────────────────┐       ┌────────────────┐
│    Personas    │◄──────┤  Responsables  │
│  (Personas)    │       │CompraCredito   │
└────────────────┘       └────────┬───────┘
                                  │
┌────────────────┐       ┌────────▼───────┐       ┌────────────────┐
│   Tarjetas     │◄──────┤ ComprasCredito │──────►│ CuotasDetalle  │
│  (Tarjetas)    │       │                │       │                │
└────────────────┘       └────────────────┘       └────────────────┘

┌────────────────┐
│   Préstamos    │
│  (Prestamos)   │
└────────────────┘
```

### **Relaciones:**
- `ComprasCredito` **N:1** `Tarjetas` (FK: tarjeta)
- `CuotasDetalle` **N:1** `ComprasCredito` (FK: compra)
- `ResponsablesComprasCredito` **N:1** `ComprasCredito` (FK: compra_credito)
- `ResponsablesComprasCredito` **N:1** `Personas` (FK: persona)

---

## 📈 Métricas del Proyecto

### **Líneas de Código (estimado)**
- Controllers: ~1,500 líneas
- Servicios: ~500 líneas
- Repositorios: ~2,000 líneas
- Modelos: ~200 líneas
- **Total: ~4,200 líneas de Scala**

### **Endpoints Implementados**
- **Total:** 25+ endpoints REST
- **Públicos:** 4 (auth)
- **Protegidos:** 21+

### **Entidades de Dominio**
- 8 entidades principales
- 3 tablas de relación

---

## 🎓 Conclusión

### **Fortalezas:**
✅ Arquitectura en capas bien definida
✅ Separación de responsabilidades
✅ Uso de patrones (Repository, Service Layer)
✅ Programación funcional y asíncrona
✅ Seguridad básica implementada (JWT, BCrypt)
✅ Funcionalidad CSV robusta y flexible
✅ Cálculos financieros correctos

### **Debilidades:**
⚠️ Credenciales en código fuente (crítico)
⚠️ Sin tests automatizados
⚠️ SQL manual sin ORM
⚠️ Sin paginación en listados
⚠️ Manejo de errores inconsistente
⚠️ Sin documentación de API (Swagger)
⚠️ Sin monitoring ni métricas

### **Recomendaciones Prioritarias:**
1. **Externalizar credenciales** (variables de entorno)
2. **Implementar tests** (unitarios e integración)
3. **Agregar ORM** (Slick para type-safety)
4. **Configurar CORS** (para frontend)
5. **Documentar API** (Swagger/OpenAPI)
6. **Agregar paginación** en listados grandes
7. **Implementar rate limiting** (seguridad)

---

**Última actualización:** 2026-01-16  
**Versión de la aplicación:** 1.0-SNAPSHOT  
**Autor del análisis:** GitHub Copilot

