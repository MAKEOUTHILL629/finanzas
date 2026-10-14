# 🚀 Despliegue en AWS EC2 con Docker Hub

Guía completa para desplegar la aplicación Finanzas en AWS EC2 usando Docker Hub como registry de imágenes (gratuito con repositorio privado).

## 📋 Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND                             │
│              Angular App (separada)                     │
│         Desplegada en: Netlify/Vercel/S3               │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS/REST API
                     ▼
┌─────────────────────────────────────────────────────────┐
│                  AWS EC2 (t2.micro)                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │          Docker Container                        │  │
│  │     Finanzas Backend (Scala + Play)              │  │
│  │              Puerto 9000                         │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────┘
                     │ JDBC
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Supabase PostgreSQL                        │
│          (Base de datos gestionada)                     │
└─────────────────────────────────────────────────────────┘

         Imagen Docker almacenada en:
┌─────────────────────────────────────────────────────────┐
│              Docker Hub (Privado)                       │
│          tuusername/finanzas-app:latest                 │
└─────────────────────────────────────────────────────────┘
```

---

## 🔧 Prerrequisitos

### 1. Cuenta de Docker Hub (Gratuita)
1. Crear cuenta en [hub.docker.com](https://hub.docker.com)
2. Confirmar email
3. **Límite gratuito:** 1 repositorio privado ilimitado

### 2. En tu Máquina Local
- ✅ Docker Desktop instalado y corriendo
- ✅ Git (opcional)
- ✅ Cuenta AWS (Free Tier disponible)

### 3. En AWS
- ✅ Cuenta AWS activa
- ✅ Key pair (.pem) para SSH

---

## 📦 PASO 1: Construir y Subir a Docker Hub

### 1.1 Configurar Variables de Entorno

Crea archivo `.env` basado en `.env.example`:

```bash
cp .env.example .env
```

Edita `.env`:
```bash
# Docker Hub
DOCKER_USERNAME=tu_username_dockerhub

# Base de datos Supabase
DB_URL=jdbc:postgresql://xxxxx.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=postgres.xxxxxxx
DB_PASSWORD=tu_password_seguro

# Seguridad - Generar con: openssl rand -base64 64
APP_SECRET=clave_secreta_minimo_32_caracteres_muy_larga_y_aleatoria

# JWT
JWT_EXPIRATION=3600
```

### 1.2 Ejecutar Script de Build & Push

**Windows (PowerShell):**
```powershell
# Primera vez: dar permisos
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Ejecutar script
.\docker-build-push-hub.ps1
```

**Linux/Mac:**
```bash
# Primera vez: dar permisos
chmod +x docker-build-push-hub.sh

# Ejecutar script
./docker-build-push-hub.sh
```

El script te pedirá:
1. Tu username de Docker Hub
2. Tu password de Docker Hub
3. Construirá la imagen (5-10 minutos)
4. Subirá la imagen a Docker Hub

**Salida esperada:**
```
========================================
  ✓ Imagen subida exitosamente
========================================

Imagen disponible en Docker Hub:
  tuusername/finanzas-app:1.0.0
  tuusername/finanzas-app:latest
```

### 1.3 Hacer el Repositorio Privado

1. Ve a: `https://hub.docker.com/repository/docker/tuusername/finanzas-app`
2. Click en **"Settings"**
3. En **"Visibility"** selecciona **"Private"**
4. **Save**

✅ Ahora tu imagen está segura y solo tú puedes acceder

---

## 🖥️ PASO 2: Configurar AWS EC2

### 2.1 Lanzar Instancia EC2

1. **AWS Console → EC2 → Launch Instance**

2. **Configuración:**

   | Opción | Valor |
   |--------|-------|
   | **Name** | `finanzas-backend-prod` |
   | **AMI** | Ubuntu Server 22.04 LTS (Free tier eligible) |
   | **Instance type** | `t2.micro` (Free Tier) o `t3.small` |
   | **Key pair** | Crear nueva o seleccionar existente |
   | **Storage** | 20 GB gp3 |

3. **Network settings - Security Group:**
   
   Crear nuevo Security Group con estas reglas:

   | Type | Port | Source | Description |
   |------|------|--------|-------------|
   | SSH | 22 | Mi IP | SSH desde tu IP |
   | HTTP | 80 | 0.0.0.0/0 | Tráfico web público |
   | Custom TCP | 9000 | 0.0.0.0/0 | API directa (temporal) |

4. **Advanced details - User data** (Opcional pero recomendado):
   ```bash
   #!/bin/bash
   apt-get update
   apt-get install -y ca-certificates curl gnupg
   
   # Instalar Docker
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
   chmod a+r /etc/apt/keyrings/docker.gpg
   
   echo \
     "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
     "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
     tee /etc/apt/sources.list.d/docker.list > /dev/null
   
   apt-get update
   apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   
   # Agregar ubuntu al grupo docker
   usermod -aG docker ubuntu
   
   systemctl enable docker
   systemctl start docker
   ```

5. **Launch instance**

### 2.2 Asignar Elastic IP (Recomendado)

Para que tu IP no cambie al reiniciar:

1. **EC2 Console → Elastic IPs → Allocate Elastic IP address**
2. **Actions → Associate Elastic IP address**
3. Seleccionar tu instancia
4. **Associate**

---

## 🚢 PASO 3: Desplegar en EC2

### 3.1 Conectarse a EC2

```bash
# Conectar por SSH
ssh -i /path/to/your-key.pem ubuntu@your-ec2-public-ip

# Si usas Windows, puedes usar Git Bash o PowerShell
```

### 3.2 Verificar Docker

```bash
# Verificar que Docker está instalado
docker --version

# Si no está instalado, ejecutar:
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ubuntu

# Cerrar sesión y volver a conectar para aplicar cambios
exit
# Conectar nuevamente
```

### 3.3 Crear Archivo de Variables de Entorno

```bash
# Crear archivo .env en el home del usuario
nano ~/.env
```

Pegar el contenido (ajustar con tus valores reales):
```bash
DOCKER_USERNAME=tu_username_dockerhub
DB_URL=jdbc:postgresql://xxxxx.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=postgres.xxxxxxx
DB_PASSWORD=tu_password_real_aqui
APP_SECRET=tu_clave_secreta_larga_y_segura_minimo_32_caracteres
JWT_EXPIRATION=3600
JAVA_OPTS=-Xmx700m -Xms256m -XX:+UseG1GC
PLAY_HTTP_CONTEXT=/
```

Guardar: `Ctrl+X`, luego `Y`, luego `Enter`

### 3.4 Crear docker-compose.yml en EC2

```bash
nano ~/docker-compose.yml
```

Pegar:
```yaml
version: '3.8'

services:
  finanzas-app:
    image: ${DOCKER_USERNAME}/finanzas-app:latest
    container_name: finanzas-app
    restart: unless-stopped
    
    ports:
      - "80:9000"
      - "9000:9000"
    
    env_file:
      - .env
    
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Guardar: `Ctrl+X`, `Y`, `Enter`

### 3.5 Login a Docker Hub desde EC2

```bash
# Login con tu usuario de Docker Hub
docker login

# Te pedirá:
# Username: tu_username
# Password: tu_password
```

### 3.6 Lanzar la Aplicación

```bash
# Cargar variables de entorno
source ~/.env

# Descargar la imagen
docker pull ${DOCKER_USERNAME}/finanzas-app:latest

# Lanzar con docker-compose
docker-compose up -d

# Ver logs
docker-compose logs -f
```

### 3.7 Verificar que Funciona

```bash
# Health check local
curl http://localhost:9000/api/health

# Debería responder:
# {"status":"UP","database":"connected","timestamp":1705400000000}
```

**Desde tu navegador:**
```
http://your-ec2-public-ip/api/health
http://your-ec2-public-ip:9000/api/health
```

---

## 🔐 PASO 4: Configuración de Seguridad

### 4.1 Configurar CORS para Angular

En tu EC2, editar el archivo de configuración (si es necesario ajustar CORS dinámicamente):

```bash
docker exec -it finanzas-app cat /app/conf/application.conf | grep cors
```

Para actualizar CORS permanentemente, debes reconstruir la imagen con tu dominio de Angular.

En `conf/application.conf` del código fuente (local):
```hocon
play.filters.cors {
  allowedOrigins = [
    "http://localhost:4200",              # Desarrollo Angular local
    "https://tu-app-angular.netlify.app",  # Producción Angular
    "https://tudominio.com"               # Tu dominio custom
  ]
  allowedHttpMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]
  allowedHttpHeaders = ["Accept", "Content-Type", "Authorization", "X-Requested-With"]
}
```

Luego reconstruir y subir imagen:
```bash
./docker-build-push-hub.sh  # o .ps1
```

### 4.2 Variables de Entorno Seguras

**NUNCA** subir `.env` a Git. Usar AWS Secrets Manager o almacenar de forma segura.

### 4.3 Restringir SSH

En Security Group de AWS:
- SSH (22): Solo desde tu IP (no 0.0.0.0/0)

---

## 🔄 PASO 5: Actualizar la Aplicación

### 5.1 En tu Máquina Local

```bash
# 1. Hacer cambios en el código
git add .
git commit -m "Actualización de funcionalidad"

# 2. Actualizar versión (opcional, en script)
# VERSION="1.0.1"

# 3. Construir y subir nueva imagen
./docker-build-push-hub.sh  # Windows: .ps1
```

### 5.2 En EC2

```bash
# Conectar por SSH
ssh -i your-key.pem ubuntu@your-ec2-ip

# Login a Docker Hub
docker login

# Descargar nueva imagen
docker-compose pull

# Reiniciar con nueva imagen
docker-compose down
docker-compose up -d

# Verificar logs
docker-compose logs -f
```

**Downtime:** ~10-30 segundos durante el restart

---

## 📊 Monitoreo

### Ver Logs

```bash
# Logs en tiempo real
docker-compose logs -f

# Últimas 100 líneas
docker-compose logs --tail=100

# Logs con timestamps
docker-compose logs -f --timestamps
```

### Ver Estado

```bash
# Estado de contenedores
docker ps

# Uso de recursos
docker stats

# Health check
curl http://localhost:9000/api/health
```

### Recursos del Sistema

```bash
# Memoria
free -h

# Disco
df -h

# CPU y procesos
htop  # o top
```

---

## 🐛 Troubleshooting

### La app no inicia

```bash
# Ver logs detallados
docker logs finanzas-app

# Verificar variables de entorno
docker exec finanzas-app env | grep -E "DB_|APP_"

# Verificar conectividad a Supabase
nc -zv your-supabase-host.com 6543
```

### No puedo conectar desde Angular

1. **Verificar CORS:**
   ```bash
   # Probar con curl
   curl -H "Origin: http://localhost:4200" \
        -H "Access-Control-Request-Method: GET" \
        -H "Access-Control-Request-Headers: Content-Type" \
        -X OPTIONS \
        http://your-ec2-ip/api/compras-credito
   ```

2. **Verificar Security Group:** Puertos 80 y 9000 abiertos

3. **Verificar que la app está corriendo:**
   ```bash
   docker ps
   curl http://localhost:9000/api/health
   ```

### Error de memoria (OOMKilled)

```bash
# Reducir memoria en docker-compose.yml o .env
JAVA_OPTS=-Xmx500m -Xms200m

# Reiniciar
docker-compose restart
```

### Error al descargar imagen desde Docker Hub

```bash
# Verificar que estás logueado
docker login

# Verificar que el repo es privado y tienes acceso
docker pull tuusername/finanzas-app:latest

# Ver imágenes locales
docker images
```

---

## 💰 Costos Estimados

| Servicio | Costo | Notas |
|----------|-------|-------|
| **Docker Hub** | **$0/mes** | 1 repo privado gratis |
| **EC2 t2.micro** | **$0-8.50/mes** | Gratis primer año (Free Tier) |
| **Elastic IP** | **$0** | Gratis si está asociado |
| **Data Transfer** | **$0-5/mes** | 100GB/mes gratis |
| **Supabase Free** | **$0/mes** | 500MB DB, 2GB bandwidth |
| **Total (después de Free Tier)** | **~$8-15/mes** | |

**Comparación con ECR (AWS):**
- ECR: ~$1/mes + costos de transfer
- Docker Hub: $0/mes 🎉

---

## ✅ Checklist de Despliegue

- [ ] Cuenta Docker Hub creada
- [ ] Repositorio privado en Docker Hub
- [ ] Imagen construida y subida
- [ ] EC2 instancia creada (t2.micro)
- [ ] Security Group configurado
- [ ] Elastic IP asignada
- [ ] Docker instalado en EC2
- [ ] `.env` configurado en EC2
- [ ] Login a Docker Hub desde EC2
- [ ] Imagen descargada en EC2
- [ ] Aplicación corriendo
- [ ] Health check funcionando
- [ ] CORS configurado para Angular
- [ ] Supabase conectado correctamente
- [ ] Frontend Angular apunta al EC2
- [ ] Tests de integración pasando

---

## 📚 Próximos Pasos

### 1. HTTPS con Let's Encrypt (Recomendado)

```bash
# Instalar Nginx
sudo apt install nginx certbot python3-certbot-nginx

# Configurar Nginx como reverse proxy
sudo nano /etc/nginx/sites-available/finanzas

# Obtener certificado SSL
sudo certbot --nginx -d tudominio.com
```

### 2. Dominio Personalizado

1. Comprar dominio (Namecheap, Google Domains, etc.)
2. Configurar registro A apuntando a tu Elastic IP
3. Actualizar CORS con tu dominio

### 3. CI/CD Automático

**GitHub Actions:**
```yaml
name: Deploy to EC2
on:
  push:
    branches: [ main ]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Build and push
        run: |
          docker login -u ${{ secrets.DOCKER_USERNAME }} -p ${{ secrets.DOCKER_PASSWORD }}
          ./docker-build-push-hub.sh
      - name: Deploy to EC2
        # SSH y docker-compose pull/restart
```

---

## 🆘 Soporte

### Logs de Producción

```bash
# Conectar a EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# Ver logs
docker-compose logs -f

# Ver logs de aplicación
docker logs finanzas-app --tail 200

# Guardar logs a archivo
docker logs finanzas-app > ~/logs.txt
```

### Comandos Útiles

```bash
# Reiniciar aplicación
docker-compose restart

# Ver configuración
docker-compose config

# Limpiar recursos no usados
docker system prune -a

# Ver espacio usado
docker system df
```

---

## 📞 Contacto y Recursos

- **Docker Hub:** https://hub.docker.com
- **AWS EC2:** https://aws.amazon.com/ec2/
- **Supabase:** https://supabase.com
- **Play Framework:** https://www.playframework.com

---

**Última actualización:** 2026-01-16  
**Versión:** 1.0.0  
**Stack:** Scala + Play + Angular + PostgreSQL + Docker + AWS

