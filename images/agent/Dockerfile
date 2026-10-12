# Образ исполнителя фабрики: обвязки агентов за одним контрактом (factory-agent)
# и публикация результата (factory-publish). scripts/stand-up.sh собирает его на хосте
# и загружает в Docker заданий агента и проверок, когда содержимое каталога меняется.
FROM docker.io/library/node:24.21.0-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Сканеры для проверок PR, все под лицензиями OSI: Gitleaks (MIT) - секреты,
# OSV-Scanner (Apache-2.0) - уязвимые зависимости, Opengrep (LGPL-2.1) - статический
# анализ по правилам фабрики. Суммы gitleaks и osv-scanner - из файлов сумм релиза,
# opengrep - посчитана при закреплении версии. Сборка - только для amd64.
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG OSV_SCANNER_VERSION=2.6.0
ARG OSV_SCANNER_SHA256=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
ARG OPENGREP_VERSION=1.30.1
ARG OPENGREP_SHA256=d3195b9d8d5ae93179f6aa5f5daaba6a920a5a09d38c5d5ae5e60924050210c4
# yq (MIT) - чтение настроек фабрики (.factory/config.yml); сумма сверена с файлом сумм релиза.
ARG YQ_VERSION=4.53.6
ARG YQ_SHA256=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
RUN cd /tmp \
	&& curl -fsSLo gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
	&& echo "${GITLEAKS_SHA256}  gitleaks.tgz" | sha256sum -c - \
	&& tar -xzf gitleaks.tgz gitleaks && install -m 755 gitleaks /usr/local/bin/ \
	&& curl -fsSLo osv-scanner "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
	&& echo "${OSV_SCANNER_SHA256}  osv-scanner" | sha256sum -c - \
	&& install -m 755 osv-scanner /usr/local/bin/ \
	&& curl -fsSLo opengrep "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_x86" \
	&& echo "${OPENGREP_SHA256}  opengrep" | sha256sum -c - \
	&& install -m 755 opengrep /usr/local/bin/ \
	&& curl -fsSLo yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
	&& echo "${YQ_SHA256}  yq" | sha256sum -c - \
	&& install -m 755 yq /usr/local/bin/ \
	&& rm -f gitleaks.tgz gitleaks osv-scanner opengrep yq

# Версии закреплены. Claude Code - проприетарный CLI, в фабрике он сменный
# исполнитель для подписки владельца; остальные - открытые (MIT, Apache-2.0).
# OpenSpec (MIT) - спецификации в репозитории: его навыки вызывают CLI openspec.
# StrykerJS (Apache-2.0) - мутационное тестирование в проверках PR с настройками фабрики.
RUN npm install -g \
	opencode-ai@1.19.0 \
	@openai/codex@0.162.1 \
	@anthropic-ai/claude-code@2.1.296 \
	@fission-ai/openspec@1.13.2 \
	@stryker-mutator/core@10.0.0 \
	&& npm cache clean --force

COPY opencode.json /etc/factory/opencode.json
COPY factory-agent factory-publish factory-untrusted factory-role factory-feedback factory-tasks factory-acceptance factory-mutation /usr/local/bin/
COPY prompts /etc/factory/prompts
COPY checks /etc/factory/checks

# Обвязки не обновляются сами и не скачивают лишнего во время задания.
# UTF-8 нужен Opengrep (Python): иначе он не читает файлы с кириллицей.
ENV LANG=C.UTF-8 \
	OPENCODE_CONFIG=/etc/factory/opencode.json \
	OPENCODE_DISABLE_AUTOUPDATE=true \
	OPENCODE_DISABLE_LSP_DOWNLOAD=true \
	OPENCODE_DISABLE_MODELS_FETCH=true \
	DISABLE_AUTOUPDATER=1 \
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
	OPENSPEC_TELEMETRY=0 \
	DO_NOT_TRACK=1
