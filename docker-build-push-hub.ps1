# ============================================
# Script PowerShell para construir y subir imagen Docker
# a Docker Hub (repositorio privado)
# ============================================

# Configurar manejo de errores
$ErrorActionPreference = "Stop"

# Variables de configuración
$APP_NAME = "finanzas-app"
$VERSION = "1.0.0"

Write-Host "========================================" -ForegroundColor Green
Write-Host "  Finanzas App - Docker Build & Push" -ForegroundColor Green
Write-Host "  Destino: Docker Hub (privado)" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# Verificar que estamos en el directorio correcto
if (!(Test-Path "build.sbt")) {
    Write-Host "Error: Este script debe ejecutarse desde el directorio raíz del proyecto" -ForegroundColor Red
    exit 1
}

# Verificar que Docker está instalado y corriendo
try {
    docker info | Out-Null
} catch {
    Write-Host "Error: Docker no está corriendo" -ForegroundColor Red
    exit 1
}

# Solicitar Docker Hub username
Write-Host "Ingresa tu username de Docker Hub:" -ForegroundColor Yellow
$DOCKER_USERNAME = Read-Host
if ([string]::IsNullOrWhiteSpace($DOCKER_USERNAME)) {
    Write-Host "Error: Username de Docker Hub es requerido" -ForegroundColor Red
    exit 1
}

# Construir URLs de las imágenes
$IMAGE_NAME = "$DOCKER_USERNAME/$APP_NAME"
$IMAGE_URI = "${IMAGE_NAME}:$VERSION"
$IMAGE_URI_LATEST = "${IMAGE_NAME}:latest"

Write-Host "Imagen: $IMAGE_URI" -ForegroundColor Yellow
Write-Host "Imagen: $IMAGE_URI_LATEST" -ForegroundColor Yellow

# Login a Docker Hub
Write-Host "Autenticando con Docker Hub..." -ForegroundColor Yellow
Write-Host "Por favor ingresa tu password de Docker Hub" -ForegroundColor Yellow
docker login

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al autenticar con Docker Hub" -ForegroundColor Red
    exit 1
}
Write-Host "Autenticación exitosa" -ForegroundColor Green

# Construir imagen Docker
Write-Host "Construyendo imagen Docker..." -ForegroundColor Yellow
Write-Host "Esto puede tomar varios minutos..." -ForegroundColor Yellow
docker build -t $IMAGE_URI -t $IMAGE_URI_LATEST .

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al construir la imagen Docker" -ForegroundColor Red
    exit 1
}
Write-Host "Imagen construida exitosamente" -ForegroundColor Green

# Subir imagen a Docker Hub
Write-Host "Subiendo imagen a Docker Hub..." -ForegroundColor Yellow
docker push $IMAGE_URI
docker push $IMAGE_URI_LATEST

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al subir la imagen a Docker Hub" -ForegroundColor Red
    exit 1
}

Write-Host "========================================" -ForegroundColor Green
Write-Host "  ✓ Imagen subida exitosamente" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Imagen disponible en Docker Hub:"
Write-Host "  $IMAGE_URI" -ForegroundColor Green
Write-Host "  $IMAGE_URI_LATEST" -ForegroundColor Green
Write-Host ""
Write-Host "Para desplegar en EC2:"
Write-Host "  docker pull $IMAGE_URI_LATEST" -ForegroundColor Yellow
Write-Host "  docker run -d -p 80:9000 --env-file .env $IMAGE_URI_LATEST" -ForegroundColor Yellow
Write-Host ""
Write-Host "Para hacer el repositorio privado:"
Write-Host "  1. Ve a https://hub.docker.com/repository/docker/$DOCKER_USERNAME/$APP_NAME" -ForegroundColor Cyan
Write-Host "  2. Click en 'Settings'" -ForegroundColor Cyan
Write-Host "  3. Cambiar visibilidad a 'Private'" -ForegroundColor Cyan
Write-Host ""
Write-Host "Siguiente paso: Configurar EC2 (ver DEPLOY_AWS.md)" -ForegroundColor Green

