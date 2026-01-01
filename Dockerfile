# Multi-stage build
FROM openjdk:11 AS build

# Instalar sbt (ejemplo, verifica el método de instalación más reciente para sbt)
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    echo "deb https://repo.scala-sbt.org/scalasbt/debian all main" | tee /etc/apt/sources.list.d/sbt.list && \
    echo "deb https://repo.scala-sbt.org/scalasbt/debian /" | tee /etc/apt/sources.list.d/sbt_old.list && \
    curl -sL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" | gpg --no-default-keyring --keyring gnupg-ring:/etc/apt/trusted.gpg.d/scalasbt-release.gpg --import && \
    chmod 644 /etc/apt/trusted.gpg.d/scalasbt-release.gpg && \
    apt-get update && \
    apt-get install -y sbt

# Establecer directorio de trabajo
WORKDIR /app

COPY . .

# Compilar y empaquetar la aplicación
RUN sbt clean compile stage

# Imagen final más ligera
FROM openjdk:11-jre-slim

WORKDIR /app

# Copiar la aplicación empaquetada desde la etapa de build
COPY --from=build /app/target/universal/stage/ .

# Copiar archivos de configuración
COPY conf/ conf/

# Exponer el puerto (ajusta según tu aplicación)
EXPOSE 9000

# Variables de entorno para configuración
ENV JAVA_OPTS="-Xmx512m -Xms256m"
ENV CONFIG_FILE="conf/application.conf"

# Comando para ejecutar la aplicación
CMD ["./bin/finanzas"]