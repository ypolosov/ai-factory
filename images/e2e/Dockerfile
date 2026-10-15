# Образ шага "e2e на стенде": Playwright с браузерами (версия - как у @playwright/test цели)
# и шаг фабрики factory-e2e (Node 24 стирает типы, зависимостей нет).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
COPY factory-e2e.ts /usr/local/lib/factory/factory-e2e.ts
ENV CI=1
CMD ["node", "/usr/local/lib/factory/factory-e2e.ts"]
