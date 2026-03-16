#!/bin/bash

# ============================================
# Script para construir y subir imagen Docker
# a AWS ECR (Elastic Container Registry)
# ============================================

set -e  # Salir si hay errores

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Variables de configuración
APP_NAME="finanzas-app"
AWS_REGION="us-east-1"  # Cambiar según tu región
AWS_ACCOUNT_ID=""       # Se obtendrá automáticamente
ECR_REGISTRY=""         # Se construirá automáticamente
VERSION="1.0.0"         # Versión de la imagen

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Finanzas App - Docker Build & Push${NC}"
echo -e "${GREEN}========================================${NC}"

# Verificar que estamos en el directorio correcto
if [ ! -f "build.sbt" ]; then
    echo -e "${RED}Error: Este script debe ejecutarse desde el directorio raíz del proyecto${NC}"
    exit 1
fi

# Verificar que Docker está instalado y corriendo
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker no está corriendo${NC}"
    exit 1
fi

# Verificar que AWS CLI está instalado
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI no está instalado${NC}"
    echo "Instalar con: pip install awscli"
    exit 1
fi

# Obtener AWS Account ID
echo -e "${YELLOW}Obteniendo AWS Account ID...${NC}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo -e "${RED}Error: No se pudo obtener el AWS Account ID. Verificar credenciales AWS${NC}"
    exit 1
fi
echo -e "${GREEN}AWS Account ID: $AWS_ACCOUNT_ID${NC}"

# Construir URL del registry
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${APP_NAME}:${VERSION}"
IMAGE_URI_LATEST="${ECR_REGISTRY}/${APP_NAME}:latest"

echo -e "${YELLOW}Registry: $ECR_REGISTRY${NC}"
echo -e "${YELLOW}Imagen: $IMAGE_URI${NC}"

# Crear repositorio en ECR si no existe
echo -e "${YELLOW}Verificando repositorio ECR...${NC}"
if ! aws ecr describe-repositories --repository-names ${APP_NAME} --region ${AWS_REGION} > /dev/null 2>&1; then
    echo -e "${YELLOW}Creando repositorio ECR: ${APP_NAME}${NC}"
    aws ecr create-repository \
        --repository-name ${APP_NAME} \
        --region ${AWS_REGION} \
        --image-scanning-configuration scanOnPush=true \
        --tags Key=Application,Value=Finanzas Key=Environment,Value=Production
    echo -e "${GREEN}Repositorio creado exitosamente${NC}"
else
    echo -e "${GREEN}Repositorio ECR ya existe${NC}"
fi

# Login a ECR
echo -e "${YELLOW}Autenticando con ECR...${NC}"
aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${ECR_REGISTRY}

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al autenticar con ECR${NC}"
    exit 1
fi
echo -e "${GREEN}Autenticación exitosa${NC}"

# Construir imagen Docker
echo -e "${YELLOW}Construyendo imagen Docker...${NC}"
echo -e "${YELLOW}Esto puede tomar varios minutos...${NC}"
docker build -t ${APP_NAME}:${VERSION} -t ${APP_NAME}:latest .

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al construir la imagen Docker${NC}"
    exit 1
fi
echo -e "${GREEN}Imagen construida exitosamente${NC}"

# Etiquetar imagen para ECR
echo -e "${YELLOW}Etiquetando imagen para ECR...${NC}"
docker tag ${APP_NAME}:${VERSION} ${IMAGE_URI}
docker tag ${APP_NAME}:latest ${IMAGE_URI_LATEST}

# Subir imagen a ECR
echo -e "${YELLOW}Subiendo imagen a ECR...${NC}"
docker push ${IMAGE_URI}
docker push ${IMAGE_URI_LATEST}

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al subir la imagen a ECR${NC}"
    exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✓ Imagen subida exitosamente${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Imagen disponible en:"
echo -e "  ${GREEN}${IMAGE_URI}${NC}"
echo -e "  ${GREEN}${IMAGE_URI_LATEST}${NC}"
echo ""
echo -e "Para desplegar en EC2, usar:"
echo -e "  ${YELLOW}docker pull ${IMAGE_URI_LATEST}${NC}"
echo ""
echo -e "${GREEN}Siguiente paso: Configurar EC2 (ver DEPLOY_AWS.md)${NC}"

