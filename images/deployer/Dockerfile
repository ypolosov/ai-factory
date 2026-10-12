# Служба выкладки фабрики: сама забирает слитые в main коммиты целевых репозиториев,
# собирает образ по рецепту фабрики, проверяет его Trivy, запускает на стенде
# (Docker стенда - deploy-dind), проверяет здоровье и откатывается по тегу.
# Задания Actions доступа к Docker не получают: выкладывает только эта служба.
FROM docker.io/library/docker:29.9.0-cli

RUN apk add --no-cache git curl jq

# Trivy (Apache-2.0) - проверка образа перед выкладкой. Сумма - из файла сумм релиза.
ARG TRIVY_VERSION=0.74.0
ARG TRIVY_SHA256=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a
RUN cd /tmp \
	&& curl -fsSLo trivy.tgz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
	&& echo "${TRIVY_SHA256}  trivy.tgz" | sha256sum -c - \
	&& tar -xzf trivy.tgz trivy && install -m 755 trivy /usr/local/bin/ \
	&& rm -f trivy.tgz trivy

COPY deployer /usr/local/bin/deployer
COPY recipes /etc/deployer/recipes
COPY runtime /etc/deployer/runtime

# Свой uid: сокет Docker стенда доступен группе 1000; тома состояния и кэша
# получают владельца из образа при первом подключении.
RUN mkdir -p /state /cache && chown 1000:1000 /state /cache
USER 1000:1000
ENV HOME=/tmp DOCKER_CONFIG=/tmp/.docker
ENTRYPOINT ["deployer"]
CMD ["watch"]
