# Обёртка над claude -p (claude-cli.ts): подписка Claude для приложений с API OpenAI
# (база знаний Onyx, путь kb-claude-cli шлюза). Claude Code - та же версия, что в образе
# исполнителя.
FROM docker.io/library/node:24.21.0-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code@2.1.296 && npm cache clean --force
COPY claude-cli.ts /app/claude-cli.ts
ENV NODE_ENV=production PORT=8000 HOME=/home/node \
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
USER node
EXPOSE 8000
CMD ["node", "/app/claude-cli.ts"]
