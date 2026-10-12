# Рецепт фабрики для приложения Node без зависимостей для работы: код из src/, запуск
# node src/server.ts (TypeScript: Node 24 стирает типы сам, без сборки) или src/server.js
# на порту 8080. Шаги сборки задаёт фабрика, а не репозиторий. Фабрика добавляет сбор
# ошибок (контекст сборки runtime, errors.ts): падение приложения уходит в GlitchTip.
FROM docker.io/library/node:24.21.0-alpine3.24
# npm, npx, yarn и corepack приложению не нужны, а их зависимости - главный источник
# уязвимостей базового образа (Trivy находит их и не даёт выложить).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
	/usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --from=runtime errors.ts /factory/errors.ts
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["/bin/sh", "-c", "if [ -f src/server.ts ]; then exec node --import /factory/errors.ts src/server.ts; else exec node --import /factory/errors.ts src/server.js; fi"]
