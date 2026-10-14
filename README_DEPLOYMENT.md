# 🐳 Finanzas App - Despliegue con Docker

## 📋 Stack Tecnológico

- **Backend:** Scala + Play Framework (esta app)
- **Frontend:** Angular (repositorio separado)
- **Base de Datos:** PostgreSQL en Supabase
- **Registry:** Docker Hub (privado, gratuito)
- **Hosting:** AWS EC2 t2.micro (Free Tier)

---

## 🚀 Inicio Rápido

### Opción 1: Desarrollo Local 💻

```bash
# Construir y lanzar con PostgreSQL local
docker-compose -f docker-compose.dev.yml up --build

# Acceder: http://localhost:9000/api/health
```

📖 **Guía completa:** [DOCKER_LOCAL.md](./DOCKER_LOCAL.md)

### Opción 2: Producción en AWS ☁️

```powershell
# Windows - Construir y subir a Docker Hub
.\docker-build-push-hub.ps1

# Linux/Mac
./docker-build-push-hub.sh
```

📖 **Guía completa:** [DEPLOY_DOCKERHUB_AWS.md](./DEPLOY_DOCKERHUB_AWS.md)

---

## 📁 Archivos Principales

| Archivo | Descripción |
|---------|-------------|
| `Dockerfile` | Imagen optimizada para producción |
| `docker-compose.yml` | Configuración para AWS EC2 |
| `docker-compose.dev.yml` | Desarrollo local |
| `docker-build-push-hub.sh/ps1` | Scripts para Docker Hub |
| `.env.example` | Plantilla de variables |
| `DEPLOY_DOCKERHUB_AWS.md` | **Guía principal** ⭐ |

---

## ⚙️ Configuración Rápida

### 1. Crear archivo `.env`

```bash
cp .env.example .env
```

### 2. Configurar variables

```bash
DOCKER_USERNAME=tu_username_dockerhub
DB_URL=jdbc:postgresql://xxx.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=postgres.xxxxx
DB_PASSWORD=tu_password
APP_SECRET=$(openssl rand -base64 64)
JWT_EXPIRATION=3600
```

### 3. Build & Deploy

```bash
# Subir a Docker Hub
./docker-build-push-hub.sh

# En EC2:
docker login
docker-compose up -d
```

---

## 💰 Costos

| Servicio | Costo Mensual |
|----------|---------------|
| Docker Hub (privado) | **$0** 🎉 |
| EC2 t2.micro | $0 (Free Tier) o $8.50 |
| Supabase Free | $0 |
| **Total** | **$0-8.50/mes** |

---

## 🔐 Integración con Frontend Angular

### CORS Configuration

En `conf/application.conf`:

```hocon
play.filters.cors {
  allowedOrigins = [
    "http://localhost:4200",              # Dev local
    "https://tu-app.netlify.app",         # Producción
    "https://tudominio.com"
  ]
}
```

### Desde Angular

```typescript
// environment.prod.ts
export const environment = {
  production: true,
  apiUrl: 'http://your-ec2-ip'  // o https://api.tudominio.com
};

// service.ts
constructor(private http: HttpClient) {}

login(credentials) {
  return this.http.post(
    `${environment.apiUrl}/api/auth/login`,
    credentials
  );
}
```

---

## 🧪 Testing

```bash
# Health check
curl http://localhost:9000/api/health

# Login
curl -X POST http://localhost:9000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}'

# Listar compras (con token)
curl http://localhost:9000/api/compras-credito \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 📚 Documentación Completa

### 🚀 Despliegue
- **[DEPLOY_DOCKERHUB_AWS.md](./DEPLOY_DOCKERHUB_AWS.md)** - Guía paso a paso completa
- [DOCKER_LOCAL.md](./DOCKER_LOCAL.md) - Desarrollo local

### 🏗️ Arquitectura
- [ARQUITECTURA_Y_ANALISIS.md](./ARQUITECTURA_Y_ANALISIS.md) - Análisis completo
- [README_CSV_UPLOAD.md](./README_CSV_UPLOAD.md) - Carga masiva CSV
- [README_DELETE_UPDATE.md](./README_DELETE_UPDATE.md) - CRUD completo
- [DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md](./DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md)

---

## 🔄 Workflow de Desarrollo

```bash
# 1. Desarrollo local
docker-compose -f docker-compose.dev.yml up

# 2. Hacer cambios
git add .
git commit -m "Nueva funcionalidad"

# 3. Subir imagen
./docker-build-push-hub.sh

# 4. Desplegar en EC2
ssh ec2-user@your-ip
docker-compose pull && docker-compose up -d
```

---

## ✅ Checklist

### Local
- [ ] Docker instalado
- [ ] `.env` configurado
- [ ] App corre con `docker-compose.dev.yml`
- [ ] Health check funciona

### Producción
- [ ] Cuenta Docker Hub creada
- [ ] Repo privado en Docker Hub
- [ ] EC2 instancia lanzada
- [ ] Security Groups configurados
- [ ] `.env` en EC2
- [ ] App desplegada
- [ ] CORS configurado
- [ ] Angular conectado

---

## 🆘 Troubleshooting

### No conecta a la DB

```bash
# Verificar variables
docker exec finanzas-app env | grep DB_

# Test conexión a Supabase
nc -zv your-host.supabase.com 6543
```

### CORS Error desde Angular

```bash
# Verificar headers
curl -I http://your-ec2-ip/api/health

# Reconstruir con CORS actualizado
./docker-build-push-hub.sh
```

### Ver Logs

```bash
# En EC2
docker logs finanzas-app --tail 100 -f
```

---

## 📞 Recursos

- [Docker Hub](https://hub.docker.com)
- [AWS EC2 Free Tier](https://aws.amazon.com/ec2/pricing/)
- [Supabase](https://supabase.com)
- [Play Framework](https://www.playframework.com)

---

**Versión:** 1.0.0  
**Última actualización:** 2026-01-16  
**Mantenido por:** makeouthill.com

