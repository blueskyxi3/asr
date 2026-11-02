FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production ASR_HOST=0.0.0.0 ASR_PORT=8000 ASR_MODEL_DIR=/models
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node models.lock.json ./
COPY --chown=node:node licenses ./licenses
RUN mkdir /models && chown node:node /models
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.ASR_PORT||8000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
