# =============================================================================
# Finanzas API (NestJS) — imagen multi-stage ligera para AWS (EC2/ECS)
# Reemplazo directo (drop-in) de la imagen Play Framework: mismo puerto 9000 y mismo /health.
# =============================================================================

# ── Etapa 1: dependencias de PRODUCCIÓN ──────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# bcrypt trae binarios precompilados; las herramientas de compilación son el respaldo si no hubiera binario musl.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
# --ignore-scripts: el cliente Prisma se genera en `builder` (aquí no existe el CLI); luego se ejecuta solo el
# script de instalación de bcrypt (descarga el binario musl o, si no existe, compila con python3/make/g++).
RUN npm ci --omit=dev --ignore-scripts && npm rebuild bcrypt

# ── Etapa 2: build (TypeScript + Prisma Client) ──────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ── Etapa 3: imagen final ────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
# Prisma necesita OpenSSL en tiempo de ejecución (motor de consultas musl + openssl 3).
RUN apk add --no-cache openssl tini

ENV NODE_ENV=production \
    PORT=9000

# Solo lo necesario: dist/, node_modules/ de producción (+ cliente Prisma generado), prisma/ y public/.
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY public ./public
COPY package.json ./

USER node
EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-9000}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
