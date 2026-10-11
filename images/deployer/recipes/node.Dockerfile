# Рецепт фабрики для приложения Node без внешних зависимостей: код из src/,
# запуск node src/server.js на порту 8080. Шаги сборки задаёт фабрика, а не репозиторий.
FROM docker.io/library/node:24.21.0-alpine3.24
# npm, npx, yarn и corepack приложению не нужны, а их зависимости - главный источник
# уязвимостей базового образа (Trivy находит их и не даёт выложить).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
	/usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
