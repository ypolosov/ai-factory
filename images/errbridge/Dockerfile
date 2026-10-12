# Мост "ошибка на стенде -> задача" (errbridge.ts): оповещения GlitchTip -> задачи Forgejo.
# TypeScript без сборки (Node 24 стирает типы) и без зависимостей.
FROM docker.io/library/node:24.21.0-alpine3.24
# Пакетные менеджеры службе не нужны (и они - главный источник уязвимостей образа).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
	/usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY errbridge.ts /app/errbridge.ts
ENV NODE_ENV=production PORT=8000
USER node
EXPOSE 8000
CMD ["node", "/app/errbridge.ts"]
