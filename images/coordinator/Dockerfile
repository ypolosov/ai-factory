# Служба координатора демо на Mastra core. Контекст сборки - images/: образу нужны и
# контракты портов (images/ports). Сборки TypeScript нет: Node 24 стирает типы.
FROM docker.io/library/node:24.21.0-alpine3.24

# git - рабочая копия цели для шага и публикация патча агента.
RUN apk add --no-cache git

WORKDIR /app/coordinator
COPY coordinator/package.json coordinator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY ports/*.ts /app/ports/
COPY coordinator/*.ts ./

# Каталог данных принадлежит node: именованный том при первом подключении берёт его владельца.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
	MASTRA_TELEMETRY_DISABLED=1 \
	COORDINATOR_DATA=/data
USER node
CMD ["node", "main.ts"]
