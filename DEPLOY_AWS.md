# 🚀 Guía de Despliegue en AWS EC2

Esta guía cubre el proceso completo para construir, subir y desplegar la aplicación Finanzas en AWS EC2 usando Docker.

## 📋 Tabla de Contenidos

1. [Prerrequisitos](#prerrequisitos)
2. [Construir y Subir Imagen a ECR](#construir-y-subir-imagen-a-ecr)
3. [Configurar AWS EC2](#configurar-aws-ec2)
4. [Desplegar la Aplicación](#desplegar-la-aplicación)
5. [Configuración de Red y Seguridad](#configuración-de-red-y-seguridad)
6. [Monitoreo y Logs](#monitoreo-y-logs)
7. [Actualización de la Aplicación](#actualización-de-la-aplicación)
8. [Troubleshooting](#troubleshooting)

---

## 🔧 Prerrequisitos

### En tu Máquina Local

1. **Docker Desktop** instalado y corriendo
   ```bash
   docker --version
   ```

2. **AWS CLI** instalado y configurado
   ```bash
   # Instalar AWS CLI
   # Windows: https://aws.amazon.com/cli/
   # Linux/Mac: pip install awscli
   
   # Configurar credenciales
   aws configure
   ```
   
   Necesitarás:
   - AWS Access Key ID
   - AWS Secret Access Key
   - Default region (ej: us-east-1)

3. **Git** (opcional, para clonar el repo)

### En AWS

1. **Cuenta de AWS** activa
2. **IAM User** con permisos:
   - `AmazonEC2ContainerRegistryFullAccess`
   - `AmazonEC2FullAccess`
   - `IAMReadOnlyAccess`

---

## 📦 Construir y Subir Imagen a ECR

### Paso 1: Preparar Variables de Entorno

Crea un archivo `.env` basado en `.env.example`:

```bash
cp .env.example .env
```

Edita `.env` con tus valores reales:
```bash
DB_URL=jdbc:postgresql://tu-host.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=tu_usuario
DB_PASSWORD=tu_password_seguro
APP_SECRET=$(openssl rand -base64 64)  # Generar clave segura
JWT_EXPIRATION=3600
```

⚠️ **IMPORTANTE:** NO subir el archivo `.env` a Git (ya está en .gitignore)

### Paso 2: Ejecutar Script de Build & Push

**En Windows (PowerShell):**
```powershell
# Dar permisos de ejecución (primera vez)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Ejecutar script
.\docker-build-push.ps1
```

**En Linux/Mac:**
```bash
# Dar permisos de ejecución (primera vez)
chmod +x docker-build-push.sh

# Ejecutar script
./docker-build-push.sh
```

Este script:
- ✅ Verifica Docker y AWS CLI
- ✅ Crea repositorio en ECR si no existe
- ✅ Construye la imagen Docker
- ✅ Sube la imagen a AWS ECR

**Salida esperada:**
```
========================================
  ✓ Imagen subida exitosamente
========================================

Imagen disponible en:
  123456789.dkr.ecr.us-east-1.amazonaws.com/finanzas-app:1.0.0
  123456789.dkr.ecr.us-east-1.amazonaws.com/finanzas-app:latest
```

---

## 🖥️ Configurar AWS EC2

### Paso 1: Lanzar Instancia EC2

1. **Ir a AWS Console → EC2 → Launch Instance**

2. **Configuración recomendada:**
   - **Name:** `finanzas-app-prod`
   - **AMI:** Amazon Linux 2023 o Ubuntu 22.04 LTS
   - **Instance type:** `t2.micro` (Free Tier) o `t3.small` (mejor performance)
   - **Key pair:** Crear o seleccionar una key pair existente (descargar .pem)
   - **Network settings:**
     - Crear nuevo Security Group o usar existente
     - Permitir SSH (port 22) desde tu IP
     - Permitir HTTP (port 80) desde cualquier lugar (0.0.0.0/0)
     - Permitir Custom TCP (port 9000) desde cualquier lugar
   - **Storage:** 20 GB gp3 (suficiente para la app y logs)

3. **Configuración avanzada (User data):**
   ```bash
   #!/bin/bash
   # Actualizar sistema
   yum update -y
   
   # Instalar Docker
   yum install -y docker
   systemctl start docker
   systemctl enable docker
   
   # Agregar ec2-user al grupo docker
   usermod -aG docker ec2-user
   
   # Instalar AWS CLI v2
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   ./aws/install
   
   # Instalar Docker Compose
   curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
   chmod +x /usr/local/bin/docker-compose
   ```

4. **Launch instance**

### Paso 2: Asignar IAM Role a EC2

Para que EC2 pueda descargar imágenes de ECR:

1. **IAM Console → Roles → Create Role**
2. **Trusted entity:** AWS service → EC2
3. **Permissions:** `AmazonEC2ContainerRegistryReadOnly`
4. **Name:** `EC2-ECR-ReadOnly`
5. **Create role**
6. **EC2 Console → Instance → Actions → Security → Modify IAM role**
7. Seleccionar `EC2-ECR-ReadOnly`

---

## 🚢 Desplegar la Aplicación

### Paso 1: Conectarse a EC2

```bash
# Windows (usar Git Bash o WSL)
# Linux/Mac
ssh -i /path/to/your-key.pem ec2-user@your-ec2-ip

# Si usas Ubuntu:
ssh -i /path/to/your-key.pem ubuntu@your-ec2-ip
```

### Paso 2: Configurar Variables de Entorno en EC2

Crear archivo con variables de entorno:

```bash
sudo nano /etc/environment.d/finanzas-app.env
```

Agregar:
```bash
DB_URL=jdbc:postgresql://your-host.supabase.com:6543/postgres?prepareThreshold=0
DB_USER=postgres.xxxxx
DB_PASSWORD=your_secure_password
APP_SECRET=your_app_secret_key_here
JWT_EXPIRATION=3600
```

Guardar: `Ctrl+X`, `Y`, `Enter`

### Paso 3: Login a ECR desde EC2

```bash
# Obtener tu AWS Account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1

# Login a ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin \
  ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
```

### Paso 4: Crear docker-compose.yml en EC2

```bash
nano ~/docker-compose.yml
```

Contenido:
```yaml
version: '3.8'

services:
  finanzas-app:
    image: ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/finanzas-app:latest
    container_name: finanzas-app
    restart: unless-stopped
    ports:
      - "80:9000"    # Mapear puerto 80 (HTTP) al 9000 del contenedor
      - "9000:9000"  # Exponer también el 9000 directamente
    env_file:
      - /etc/environment.d/finanzas-app.env
    environment:
      - JAVA_OPTS=-Xmx700m -Xms256m -XX:+UseG1GC
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

### Paso 5: Lanzar la Aplicación

```bash
# Descargar la imagen
docker pull ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/finanzas-app:latest

# Iniciar con docker-compose
docker-compose up -d

# Ver logs
docker-compose logs -f
```

### Paso 6: Verificar que Funciona

```bash
# Health check
curl http://localhost:9000/api/health

# Desde tu navegador
http://your-ec2-public-ip/api/health
```

Deberías ver:
```json
{
  "status": "UP",
  "database": "connected",
  "timestamp": 1705400000000
}
```

---

## 🔐 Configuración de Red y Seguridad

### Security Groups

**Configuración recomendada:**

| Type | Protocol | Port | Source | Description |
|------|----------|------|--------|-------------|
| SSH | TCP | 22 | Mi IP | Acceso SSH |
| HTTP | TCP | 80 | 0.0.0.0/0 | Tráfico web |
| Custom TCP | TCP | 9000 | 0.0.0.0/0 | API directa |
| HTTPS | TCP | 443 | 0.0.0.0/0 | (Futuro) |

### Configurar Elastic IP (Recomendado)

Para que tu IP no cambie al reiniciar la instancia:

1. **EC2 Console → Elastic IPs → Allocate Elastic IP address**
2. **Actions → Associate Elastic IP address**
3. Seleccionar tu instancia
4. Asociar

### Configurar DNS (Opcional pero recomendado)

1. Comprar dominio (Route 53, GoDaddy, etc.)
2. Crear registro A apuntando a tu Elastic IP
3. Actualizar CORS en `application.conf`:
   ```hocon
   play.filters.cors {
     allowedOrigins = ["https://tudominio.com", "http://localhost:3000"]
   }
   ```

---

## 📊 Monitoreo y Logs

### Ver Logs de la Aplicación

```bash
# Logs en tiempo real
docker-compose logs -f

# Últimas 100 líneas
docker-compose logs --tail=100

# Logs de un servicio específico
docker logs finanzas-app

# Logs desde hace 10 minutos
docker logs --since 10m finanzas-app
```

### Monitoreo de Recursos

```bash
# Estado de contenedores
docker ps

# Uso de recursos
docker stats

# Info del sistema
free -h
df -h
top
```

### CloudWatch (Opcional)

Habilitar CloudWatch para métricas detalladas:

1. **EC2 Console → Instance → Monitoring → Enable detailed monitoring**
2. **CloudWatch Console → Logs → Create log group**
3. Instalar CloudWatch Agent en EC2

---

## 🔄 Actualización de la Aplicación

### Proceso de Actualización

1. **En tu máquina local:**
   ```bash
   # Hacer cambios en el código
   git add .
   git commit -m "Cambios realizados"
   
   # Actualizar versión en docker-build-push script
   # VERSION="1.0.1"
   
   # Construir y subir nueva imagen
   ./docker-build-push.sh
   ```

2. **En EC2:**
   ```bash
   # Conectar por SSH
   ssh -i your-key.pem ec2-user@your-ec2-ip
   
   # Login a ECR
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin \
     ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com
   
   # Descargar nueva imagen
   docker-compose pull
   
   # Reiniciar con nueva imagen
   docker-compose down
   docker-compose up -d
   
   # Verificar
   docker-compose logs -f
   ```

### Rollback (Volver a versión anterior)

```bash
# Cambiar imagen en docker-compose.yml
image: ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/finanzas-app:1.0.0

# Reiniciar
docker-compose down
docker-compose up -d
```

---

## 🐛 Troubleshooting

### Problema: La aplicación no inicia

```bash
# Ver logs detallados
docker logs finanzas-app

# Verificar variables de entorno
docker exec finanzas-app env | grep DB_

# Verificar conexión a base de datos
docker exec -it finanzas-app /bin/bash
curl http://localhost:9000/api/health
```

### Problema: No se puede conectar desde navegador

```bash
# Verificar que el contenedor está corriendo
docker ps

# Verificar puertos
netstat -tlnp | grep 9000

# Verificar Security Group en AWS Console
# Debe permitir tráfico en puerto 80 y 9000
```

### Problema: Error de memoria (OOMKilled)

```bash
# Ver uso de memoria
docker stats

# Reducir memoria en docker-compose.yml
environment:
  - JAVA_OPTS=-Xmx500m -Xms200m

# Reiniciar
docker-compose restart
```

### Problema: Error al descargar imagen de ECR

```bash
# Verificar IAM role de EC2
aws sts get-caller-identity

# Re-login a ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com

# Verificar que la imagen existe
aws ecr describe-images --repository-name finanzas-app
```

### Problema: Base de datos no conecta

```bash
# Verificar conectividad desde EC2
nc -zv your-supabase-host.com 6543

# Verificar variables de entorno
docker exec finanzas-app env | grep DB_

# Verificar logs de PostgreSQL en Supabase
# Verificar que la IP de EC2 está permitida en Supabase
```

---

## 📈 Optimizaciones para Producción

### 1. Usar HTTPS con Let's Encrypt

```bash
# Instalar Nginx como reverse proxy
sudo yum install nginx -y

# Instalar Certbot
sudo yum install certbot python3-certbot-nginx -y

# Obtener certificado
sudo certbot --nginx -d tudominio.com

# Nginx se configurará automáticamente
```

### 2. Configurar Backups Automáticos

```bash
# Crear script de backup
sudo nano /usr/local/bin/backup-finanzas.sh
```

```bash
#!/bin/bash
aws rds create-db-snapshot \
  --db-instance-identifier finanzas-db \
  --db-snapshot-identifier finanzas-backup-$(date +%Y%m%d-%H%M%S)
```

```bash
# Agregar a crontab (diario a las 2 AM)
sudo crontab -e
0 2 * * * /usr/local/bin/backup-finanzas.sh
```

### 3. Configurar Auto-restart

```bash
# Crear servicio systemd
sudo nano /etc/systemd/system/finanzas-app.service
```

```ini
[Unit]
Description=Finanzas App Docker Compose
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/ec2-user
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
# Habilitar servicio
sudo systemctl enable finanzas-app.service
sudo systemctl start finanzas-app.service
```

---

## 📝 Checklist de Despliegue

- [ ] Configurar AWS CLI con credenciales
- [ ] Construir y subir imagen a ECR
- [ ] Crear instancia EC2 con configuración correcta
- [ ] Asignar IAM role a EC2
- [ ] Configurar Security Group
- [ ] Asignar Elastic IP
- [ ] Crear archivo de variables de entorno
- [ ] Descargar imagen desde ECR
- [ ] Lanzar aplicación con docker-compose
- [ ] Verificar health check
- [ ] Configurar dominio (opcional)
- [ ] Configurar HTTPS (opcional)
- [ ] Configurar backups
- [ ] Probar actualización de la app
- [ ] Documentar credenciales de forma segura

---

## 💰 Estimación de Costos AWS (us-east-1)

- **EC2 t2.micro:** $8.50/mes (Free Tier: 750 hrs/mes gratis primer año)
- **ECR Storage:** $0.10/GB/mes (Primeros 500 MB gratis)
- **Data Transfer:** $0.09/GB salida (Primeros 100 GB/mes gratis)
- **Elastic IP:** Gratis mientras esté asignado a instancia corriendo
- **Total estimado:** ~$10-15/mes (después del Free Tier)

---

## 📚 Referencias

- [AWS ECR Documentation](https://docs.aws.amazon.com/ecr/)
- [AWS EC2 Documentation](https://docs.aws.amazon.com/ec2/)
- [Docker Documentation](https://docs.docker.com/)
- [Play Framework Production](https://www.playframework.com/documentation/2.8.x/Deploying)

---

## 🆘 Soporte

Para problemas específicos:
1. Revisar logs: `docker-compose logs`
2. Verificar health check: `curl http://localhost:9000/api/health`
3. Revisar documentación de la aplicación

---

**Última actualización:** 2026-01-16  
**Versión:** 1.0.0

