# Ревьюер фабрики: PR-Agent (MIT) и ворота factory-gate - оценка PR агента судьями из
# семейств, отличных от модели разработки, и решение: доработка, человек или готово.
# scripts/stand-up.sh собирает образ на хосте и загружает в Docker заданий проверок.
FROM docker.io/pragent/pr-agent:0.46.0

RUN apt-get update \
	&& apt-get install -y --no-install-recommends jq \
	&& rm -rf /var/lib/apt/lists/*

# yq (MIT) - чтение .factory/config.yml; сумма сверена с файлом сумм релиза.
ARG YQ_VERSION=4.53.6
ARG YQ_SHA256=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
RUN curl -fsSLo /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
	&& echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum -c - \
	&& chmod 755 /usr/local/bin/yq

COPY factory-gate /usr/local/bin/
