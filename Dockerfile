# ---- Stage 1: build ----
FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 needs to compile a native addon
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: production ----
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache python3 make g++
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Secrets/config are injected at runtime via env vars or a mounted .env,
# never baked into the image.
ENV DATABASE_URL="/app/data/prod.db"
ENV PORT=3000

RUN mkdir -p /app/data && chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
