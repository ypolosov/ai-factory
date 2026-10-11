# Образ исполнителя фабрики: обвязки агентов за одним контрактом (factory-agent)
# и публикация результата (factory-publish). scripts/stand-up.sh собирает его прямо
# в dind runner агента и проверок, когда содержимое этого каталога меняется.
FROM docker.io/library/node:24.21.0-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Версии закреплены. Claude Code - проприетарный CLI, в фабрике он сменный
# исполнитель для подписки владельца; остальные - открытые (MIT, Apache-2.0).
RUN npm install -g \
	opencode-ai@1.19.0 \
	@openai/codex@0.162.1 \
	@anthropic-ai/claude-code@2.1.296 \
	&& npm cache clean --force

COPY opencode.json /etc/factory/opencode.json
COPY factory-agent factory-publish factory-untrusted /usr/local/bin/

# Обвязки не обновляются сами и не скачивают лишнего во время задания.
ENV OPENCODE_CONFIG=/etc/factory/opencode.json \
	OPENCODE_DISABLE_AUTOUPDATE=true \
	OPENCODE_DISABLE_LSP_DOWNLOAD=true \
	OPENCODE_DISABLE_MODELS_FETCH=true \
	DISABLE_AUTOUPDATER=1 \
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
