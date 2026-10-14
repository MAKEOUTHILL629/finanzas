# ✅ Configuración Completa - Docker Hub + AWS EC2

## 🎉 Resumen de Configuración

Tu aplicación **Finanzas Backend (Scala + Play)** está ahora completamente configurada para despliegue en producción usando:

- ✅ **Docker Hub** (repositorio privado gratuito)
- ✅ **AWS EC2** (t2.micro Free Tier)
- ✅ **Supabase** (PostgreSQL gestionado)
- ✅ **CORS** configurado para Angular frontend

---

## 📁 Archivos Creados/Modificados

### 🐳 Docker & Build

| Archivo | Descripción |
|---------|-------------|
| `Dockerfile` | ✅ Optimizado para t2.micro (700MB RAM) |
| `.dockerignore` | ✅ Ignora archivos innecesarios |
| `docker-compose.yml` | ✅ Para producción (Docker Hub) |
| `docker-compose.dev.yml` | ✅ Para desarrollo local |
| `docker-build-push-hub.sh` | ⭐ **Script Linux/Mac** |
| `docker-build-push-hub.ps1` | ⭐ **Script Windows** |

### ⚙️ Configuración

| Archivo | Descripción |
|---------|-------------|
| `.env.example` | ✅ Plantilla de variables |
| `conf/application.conf` | ✅ CORS + variables de entorno |
| `conf/routes` | ✅ Health check endpoint agregado |
| `.gitignore` | ✅ Actualizado (Docker, AWS, .env) |

### 📝 Documentación

| Archivo | Descripción | Prioridad |
|---------|-------------|-----------|
| **`DEPLOY_DOCKERHUB_AWS.md`** | **Guía paso a paso completa** | ⭐⭐⭐ |
| `README_DEPLOYMENT.md` | Resumen rápido | ⭐⭐ |
| `DOCKER_LOCAL.md` | Desarrollo local | ⭐⭐ |
| `ARQUITECTURA_Y_ANALISIS.md` | Análisis de arquitectura | ⭐ |
| `DEPLOY_AWS.md` | Guía AWS con ECR (alternativa) | ⭐ |

### 🎯 Código

| Archivo | Cambio |
|---------|--------|
| `app/controllers/HomeController.scala` | ✅ Health check endpoint |
| `conf/routes` | ✅ Rutas `/` y `/api/health` |

---

## 🚀 Comandos Principales

### Desarrollo Local

```bash
# Construir y lanzar (con PostgreSQL local)
docker-compose -f docker-compose.dev.yml up --build

# Probar
curl http://localhost:9000/api/health
```

### Desplegar en Producción

```powershell
# Windows - Build & Push a Docker Hub
.\docker-build-push-hub.ps1

# Linux/Mac
chmod +x docker-build-push-hub.sh
./docker-build-push-hub.sh
```

**En EC2:**
```bash
# Login a Docker Hub
docker login

# Descargar y ejecutar
docker-compose up -d

# Ver logs
docker-compose logs -f
```

---

## 🔐 Configuración Necesaria

### 1. Crear cuenta Docker Hub

1. Ir a [hub.docker.com](https://hub.docker.com)
2. Registrarse (gratuito)
3. Confirmar email

### 2. Configurar `.env`

```bash
# Copiar plantilla
cp .env.example .env

# Editar con tus valores
DOCKER_USERNAME=tu_username
DB_URL=jdbc:postgresql://xxx.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=postgres.xxxxx
DB_PASSWORD=tu_password_seguro
APP_SECRET=$(openssl rand -base64 64)  # Generar clave segura
JWT_EXPIRATION=3600
```

### 3. Lanzar EC2

1. **AWS Console → EC2 → Launch Instance**
2. **AMI:** Ubuntu 22.04 LTS
3. **Type:** t2.micro (Free Tier)
4. **Storage:** 20GB
5. **Security Group:**
   - SSH (22) desde tu IP
   - HTTP (80) desde 0.0.0.0/0
   - TCP (9000) desde 0.0.0.0/0

### 4. Hacer repositorio privado

1. Ve a Docker Hub
2. Tu repositorio → Settings
3. Visibility → Private

---

## 📊 Arquitectura Final

```
┌─────────────────────────────────────┐
│      Frontend Angular               │
│   Netlify/Vercel/CloudFront         │
│   https://tu-app-angular.com        │
└───────────────┬─────────────────────┘
                │ REST API (CORS habilitado)
                ▼
┌─────────────────────────────────────┐
│       AWS EC2 t2.micro              │
│  ┌───────────────────────────────┐  │
│  │   Docker Container            │  │
│  │   finanzas-app:latest         │  │
│  │   Puerto: 80 → 9000           │  │
│  └───────────────────────────────┘  │
│    http://your-ec2-ip              │
└───────────────┬─────────────────────┘
                │ JDBC
                ▼
┌─────────────────────────────────────┐
│     Supabase PostgreSQL             │
│   Base de datos gestionada          │
│   xxx.supabase.com:6543             │
└─────────────────────────────────────┘

        Imagen en:
┌─────────────────────────────────────┐
│       Docker Hub (Privado)          │
│   tuusername/finanzas-app:latest    │
│        Gratuito 🎉                  │
└─────────────────────────────────────┘
```

---

## ✅ Checklist de Despliegue

### Preparación
- [ ] Cuenta Docker Hub creada
- [ ] `.env` configurado localmente
- [ ] Código probado localmente con `docker-compose.dev.yml`

### Build & Push
- [ ] Ejecutar `docker-build-push-hub.sh` o `.ps1`
- [ ] Verificar imagen en Docker Hub
- [ ] Hacer repositorio privado

### AWS EC2
- [ ] Instancia EC2 creada (t2.micro)
- [ ] Security Group configurado
- [ ] Elastic IP asignada (opcional)
- [ ] SSH funciona correctamente

### Despliegue
- [ ] `.env` configurado en EC2
- [ ] `docker-compose.yml` copiado a EC2
- [ ] Login a Docker Hub desde EC2
- [ ] `docker-compose up -d` ejecutado
- [ ] Health check responde: `/api/health`

### Frontend Integration
- [ ] CORS configurado en `application.conf`
- [ ] Angular apunta a EC2 IP
- [ ] Login funciona desde Angular
- [ ] API calls funcionan correctamente

---

## 🧪 Testing Rápido

### Backend (Health Check)

```bash
# Local
curl http://localhost:9000/api/health

# Producción
curl http://your-ec2-ip/api/health
curl http://your-ec2-ip:9000/api/health
```

**Respuesta esperada:**
```json
{
  "status": "UP",
  "database": "connected",
  "timestamp": 1705400000000
}
```

### API Endpoints

```bash
# Login
curl -X POST http://your-ec2-ip/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test123"}'

# Listar compras (con token)
curl http://your-ec2-ip/api/compras-credito \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Desde Angular

```typescript
// environment.prod.ts
export const environment = {
  production: true,
  apiUrl: 'http://your-ec2-ip'  // Sin puerto, usa 80
};
```

---

## 🔄 Workflow de Actualización

```bash
# 1. Local - Hacer cambios
git add .
git commit -m "Nueva funcionalidad"

# 2. Build & Push
./docker-build-push-hub.sh  # Windows: .ps1

# 3. SSH a EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# 4. Actualizar en EC2
docker login  # Si es necesario
docker-compose pull
docker-compose down
docker-compose up -d

# 5. Verificar
docker-compose logs -f
curl http://localhost:9000/api/health
```

**Downtime:** ~10-30 segundos

---

## 💰 Costos Mensuales

| Servicio | Plan | Costo |
|----------|------|-------|
| **Docker Hub** | Free (1 repo privado) | **$0** 🎉 |
| **EC2 t2.micro** | Free Tier (1 año) | **$0** |
| **EC2 t2.micro** | Después de Free Tier | $8.50 |
| **Supabase** | Free Plan | $0 |
| **Elastic IP** | Si está asociado | $0 |
| **Data Transfer** | 100GB gratis/mes | $0 |
| **TOTAL (primer año)** | | **$0** 🎊 |
| **TOTAL (después)** | | **~$8-10/mes** |

**vs AWS ECR:** Ahorras ~$1-2/mes usando Docker Hub

---

## 📚 Documentación por Tema

### 🚀 Quiero desplegar en producción
👉 **[DEPLOY_DOCKERHUB_AWS.md](./DEPLOY_DOCKERHUB_AWS.md)** - Guía paso a paso completa

### 💻 Quiero desarrollar localmente
👉 **[DOCKER_LOCAL.md](./DOCKER_LOCAL.md)** - Desarrollo con Docker

### 🏗️ Quiero entender la arquitectura
👉 **[ARQUITECTURA_Y_ANALISIS.md](./ARQUITECTURA_Y_ANALISIS.md)** - Análisis completo

### 📊 Quiero ver los endpoints disponibles
👉 **[README_CSV_UPLOAD.md](./README_CSV_UPLOAD.md)** - Carga CSV  
👉 **[README_DELETE_UPDATE.md](./README_DELETE_UPDATE.md)** - CRUD compras  
👉 **[DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md](./DOCUMENTACION_RESPONSABLES_UPDATE_DELETE.md)** - CRUD responsables

### 🎯 Resumen rápido
👉 **[README_DEPLOYMENT.md](./README_DEPLOYMENT.md)** - Comandos principales

---

## 🐛 Troubleshooting Común

### "Cannot connect to Docker daemon"
```bash
# Windows: Abrir Docker Desktop
# Linux: sudo systemctl start docker
```

### "Error: This script debe ejecutarse desde el directorio raíz"
```bash
# Navegar al directorio del proyecto
cd C:\Finanzas-APP\finanzas
```

### "Login Failed" en Docker Hub
```bash
# Verificar credenciales
docker logout
docker login
```

### "Health check DOWN" en producción
```bash
# Ver logs
docker logs finanzas-app

# Verificar variables de entorno
docker exec finanzas-app env | grep DB_

# Verificar conexión a Supabase
nc -zv your-host.supabase.com 6543
```

### CORS Error desde Angular
```bash
# Verificar que el origen está en application.conf
# Reconstruir imagen con CORS actualizado
./docker-build-push-hub.sh
```

---

## 🎓 Próximos Pasos Recomendados

### 1. HTTPS con Certificado SSL
- Usar Let's Encrypt (gratuito)
- Configurar Nginx como reverse proxy
- Redirigir todo a HTTPS

### 2. Dominio Personalizado
- Comprar dominio (~$10/año)
- Apuntar a tu Elastic IP
- Actualizar CORS con tu dominio

### 3. CI/CD Automático
- GitHub Actions para deploy automático
- Testing automático antes de desplegar
- Rollback automático si falla

### 4. Monitoring
- CloudWatch para logs y métricas
- Alertas por email/SMS
- Dashboard de estado

### 5. Backups
- Backups automáticos de Supabase
- Snapshots de EC2
- Versionado de imágenes Docker

---

## 📞 Soporte y Recursos

### Comandos Útiles

```bash
# Ver logs en tiempo real
docker-compose logs -f

# Ver estado de contenedores
docker ps

# Ver uso de recursos
docker stats

# Reiniciar app
docker-compose restart

# Ver configuración cargada
docker-compose config

# Limpiar recursos
docker system prune -a
```

### Enlaces Importantes

- **Docker Hub:** https://hub.docker.com
- **AWS EC2 Free Tier:** https://aws.amazon.com/free/
- **Supabase:** https://supabase.com
- **Play Framework:** https://www.playframework.com
- **Angular Docs:** https://angular.io

---

## 🎊 ¡Felicidades!

Tu aplicación está lista para producción con una configuración profesional:

✅ Docker multi-stage optimizado  
✅ Health checks configurados  
✅ CORS habilitado para Angular  
✅ Variables de entorno seguras  
✅ Logging configurado  
✅ Registry privado gratuito  
✅ Documentación completa  

**Costo total:** $0 en primer año, ~$8-10/mes después 🎉

---

**Versión:** 1.0.0  
**Fecha:** 2026-01-16  
**Stack:** Scala + Play + Angular + PostgreSQL + Docker + AWS  
**Mantenido por:** makeouthill.com

