# Загрузка Forgejo -> база знаний Hindsight (kbsync.ts). TypeScript без сборки и без зависимостей.
FROM docker.io/library/node:24.21.0-alpine3.24
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
	/usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY kbsync.ts /app/kbsync.ts
ENV NODE_ENV=production
USER node
CMD ["node", "/app/kbsync.ts"]
