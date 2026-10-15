# Камера видео-демо: Playwright без окна той же версии, что у сквозных проверок цели, и режиссёр
# film.ts (Node стирает типы). Контекст сборки - images/: режиссёру нужны порты трекера и вики.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /opt/camera
COPY camera/package.json camera/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY ports/*.ts /opt/ports/
COPY camera/*.ts ./
ENTRYPOINT ["node", "/opt/camera/film.ts"]
