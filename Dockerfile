# ============================================
# Stage 1: Build - Compilar la aplicación
# ============================================
FROM eclipse-temurin:11-jdk-focal AS build

# Instalar SBT
RUN apt-get update && \
    apt-get install -y curl gnupg apt-transport-https && \
    echo "deb https://repo.scala-sbt.org/scalasbt/debian all main" | tee /etc/apt/sources.list.d/sbt.list && \
    echo "deb https://repo.scala-sbt.org/scalasbt/debian /" | tee /etc/apt/sources.list.d/sbt_old.list && \
    curl -sL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" | \
    gpg --no-default-keyring --keyring gnupg-ring:/etc/apt/trusted.gpg.d/scalasbt-release.gpg --import && \
    chmod 644 /etc/apt/trusted.gpg.d/scalasbt-release.gpg && \
    apt-get update && \
    apt-get install -y sbt && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración de SBT primero (cacheo de dependencias)
COPY build.sbt ./
COPY project/ ./project/

# Descargar dependencias (se cachea si no cambian)
RUN sbt update

# Copiar el resto del código
COPY . .

# Compilar y empaquetar la aplicación
RUN sbt clean compile stage && \
    # Limpiar archivos innecesarios para reducir tamaño
    rm -rf ~/.sbt ~/.ivy2/cache target/*/classes

# ============================================
# Stage 2: Runtime - Imagen optimizada
# ============================================
FROM eclipse-temurin:11-jre-focal

# Crear usuario no-root para seguridad
RUN groupadd -r finanzas && useradd -r -g finanzas finanzas

# Instalar dependencias mínimas
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar la aplicación empaquetada desde la etapa de build
COPY --from=build --chown=finanzas:finanzas /app/target/universal/stage/ .

# Dar permisos de ejecución
RUN chmod +x /app/bin/finanzas

# Cambiar a usuario no-root
USER finanzas

# Exponer puerto de la aplicación
EXPOSE 9000

# Health check para AWS ECS/ELB
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:9000/api/health || exit 1

# Variables de entorno optimizadas para t2.micro (1GB RAM)
# Dejar 256MB para el sistema, usar ~700MB para JVM
ENV JAVA_OPTS="-Xmx700m -Xms256m -XX:+UseG1GC -XX:MaxGCPauseMillis=100 -XX:+UseStringDeduplication -Djava.net.preferIPv4Stack=true"
ENV APPLICATION_SECRET=""
ENV DB_URL=""
ENV DB_USER=""
ENV DB_PASSWORD=""
ENV JWT_EXPIRATION="3600"

# Comando para ejecutar la aplicación
CMD ["sh", "-c", "exec ./bin/finanzas -Dplay.http.secret.key=${APP_SECRET}"]
