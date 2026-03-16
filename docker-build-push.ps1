# ============================================
# Script PowerShell para construir y subir imagen Docker
# a AWS ECR (Elastic Container Registry)
# ============================================

# Configurar manejo de errores
$ErrorActionPreference = "Stop"

# Variables de configuración
$APP_NAME = "finanzas-app"
$AWS_REGION = "us-east-1"  # Cambiar según tu región
$VERSION = "1.0.0"

Write-Host "========================================" -ForegroundColor Green
Write-Host "  Finanzas App - Docker Build & Push" -ForegroundColor Green
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

# Verificar que AWS CLI está instalado
if (!(Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Host "Error: AWS CLI no está instalado" -ForegroundColor Red
    Write-Host "Instalar desde: https://aws.amazon.com/cli/" -ForegroundColor Yellow
    exit 1
}

# Obtener AWS Account ID
Write-Host "Obteniendo AWS Account ID..." -ForegroundColor Yellow
$AWS_ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
if (!$AWS_ACCOUNT_ID) {
    Write-Host "Error: No se pudo obtener el AWS Account ID. Verificar credenciales AWS" -ForegroundColor Red
    exit 1
}
Write-Host "AWS Account ID: $AWS_ACCOUNT_ID" -ForegroundColor Green

# Construir URL del registry
$ECR_REGISTRY = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
$IMAGE_URI = "$ECR_REGISTRY/${APP_NAME}:$VERSION"
$IMAGE_URI_LATEST = "$ECR_REGISTRY/${APP_NAME}:latest"

Write-Host "Registry: $ECR_REGISTRY" -ForegroundColor Yellow
Write-Host "Imagen: $IMAGE_URI" -ForegroundColor Yellow

# Crear repositorio en ECR si no existe
Write-Host "Verificando repositorio ECR..." -ForegroundColor Yellow
$repoExists = $false
try {
    aws ecr describe-repositories --repository-names $APP_NAME --region $AWS_REGION 2>&1 | Out-Null
    $repoExists = $true
} catch {}

if (!$repoExists) {
    Write-Host "Creando repositorio ECR: $APP_NAME" -ForegroundColor Yellow
    aws ecr create-repository `
        --repository-name $APP_NAME `
        --region $AWS_REGION `
        --image-scanning-configuration scanOnPush=true `
        --tags Key=Application,Value=Finanzas Key=Environment,Value=Production
    Write-Host "Repositorio creado exitosamente" -ForegroundColor Green
} else {
    Write-Host "Repositorio ECR ya existe" -ForegroundColor Green
}

# Login a ECR
Write-Host "Autenticando con ECR..." -ForegroundColor Yellow
$password = aws ecr get-login-password --region $AWS_REGION
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al obtener password de ECR" -ForegroundColor Red
    exit 1
}

$password | docker login --username AWS --password-stdin $ECR_REGISTRY
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al autenticar con ECR" -ForegroundColor Red
    exit 1
}
Write-Host "Autenticación exitosa" -ForegroundColor Green

# Construir imagen Docker
Write-Host "Construyendo imagen Docker..." -ForegroundColor Yellow
Write-Host "Esto puede tomar varios minutos..." -ForegroundColor Yellow
docker build -t "${APP_NAME}:${VERSION}" -t "${APP_NAME}:latest" .

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al construir la imagen Docker" -ForegroundColor Red
    exit 1
}
Write-Host "Imagen construida exitosamente" -ForegroundColor Green

# Etiquetar imagen para ECR
Write-Host "Etiquetando imagen para ECR..." -ForegroundColor Yellow
docker tag "${APP_NAME}:${VERSION}" $IMAGE_URI
docker tag "${APP_NAME}:latest" $IMAGE_URI_LATEST

# Subir imagen a ECR
Write-Host "Subiendo imagen a ECR..." -ForegroundColor Yellow
docker push $IMAGE_URI
docker push $IMAGE_URI_LATEST

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error al subir la imagen a ECR" -ForegroundColor Red
    exit 1
}

Write-Host "========================================" -ForegroundColor Green
Write-Host "  ✓ Imagen subida exitosamente" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Imagen disponible en:"
Write-Host "  $IMAGE_URI" -ForegroundColor Green
Write-Host "  $IMAGE_URI_LATEST" -ForegroundColor Green
Write-Host ""
Write-Host "Para desplegar en EC2, usar:"
Write-Host "  docker pull $IMAGE_URI_LATEST" -ForegroundColor Yellow
Write-Host ""
Write-Host "Siguiente paso: Configurar EC2 (ver DEPLOY_AWS.md)" -ForegroundColor Green

