#!/bin/bash

# ============================================
# Script para construir y subir imagen Docker
# a Docker Hub (repositorio privado)
# ============================================

set -e  # Salir si hay errores

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Variables de configuración
APP_NAME="finanzas-app"
DOCKER_USERNAME=""  # Se pedirá al usuario
VERSION="1.0.0"     # Versión de la imagen

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Finanzas App - Docker Build & Push${NC}"
echo -e "${GREEN}  Destino: Docker Hub (privado)${NC}"
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

# Solicitar Docker Hub username si no está configurado
if [ -z "$DOCKER_USERNAME" ]; then
    echo -e "${YELLOW}Ingresa tu username de Docker Hub:${NC}"
    read DOCKER_USERNAME
    if [ -z "$DOCKER_USERNAME" ]; then
        echo -e "${RED}Error: Username de Docker Hub es requerido${NC}"
        exit 1
    fi
fi

# Construir URLs de las imágenes
IMAGE_NAME="${DOCKER_USERNAME}/${APP_NAME}"
IMAGE_URI="${IMAGE_NAME}:${VERSION}"
IMAGE_URI_LATEST="${IMAGE_NAME}:latest"

echo -e "${YELLOW}Imagen: $IMAGE_URI${NC}"
echo -e "${YELLOW}Imagen: $IMAGE_URI_LATEST${NC}"

# Login a Docker Hub
echo -e "${YELLOW}Autenticando con Docker Hub...${NC}"
echo -e "${YELLOW}Por favor ingresa tu password de Docker Hub${NC}"
docker login

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al autenticar con Docker Hub${NC}"
    exit 1
fi
echo -e "${GREEN}Autenticación exitosa${NC}"

# Construir imagen Docker
echo -e "${YELLOW}Construyendo imagen Docker...${NC}"
echo -e "${YELLOW}Esto puede tomar varios minutos...${NC}"
docker build -t ${IMAGE_URI} -t ${IMAGE_URI_LATEST} .

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al construir la imagen Docker${NC}"
    exit 1
fi
echo -e "${GREEN}Imagen construida exitosamente${NC}"

# Subir imagen a Docker Hub
echo -e "${YELLOW}Subiendo imagen a Docker Hub...${NC}"
docker push ${IMAGE_URI}
docker push ${IMAGE_URI_LATEST}

if [ $? -ne 0 ]; then
    echo -e "${RED}Error al subir la imagen a Docker Hub${NC}"
    exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✓ Imagen subida exitosamente${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Imagen disponible en Docker Hub:"
echo -e "  ${GREEN}${IMAGE_URI}${NC}"
echo -e "  ${GREEN}${IMAGE_URI_LATEST}${NC}"
echo ""
echo -e "Para desplegar en EC2:"
echo -e "  ${YELLOW}docker pull ${IMAGE_URI_LATEST}${NC}"
echo -e "  ${YELLOW}docker run -d -p 80:9000 --env-file .env ${IMAGE_URI_LATEST}${NC}"
echo ""
echo -e "Para hacer el repositorio privado:"
echo -e "  1. Ve a https://hub.docker.com/repository/docker/${DOCKER_USERNAME}/${APP_NAME}"
echo -e "  2. Click en 'Settings'"
echo -e "  3. Cambiar visibilidad a 'Private'"
echo ""
echo -e "${GREEN}Siguiente paso: Configurar EC2 (ver DEPLOY_AWS.md)${NC}"

