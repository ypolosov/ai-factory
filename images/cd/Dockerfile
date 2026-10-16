# Служба выкладки цели демо: docker compose из образов GHCR в Docker выкладки стенда.
FROM docker.io/library/docker:29.9.0-cli
RUN apk add --no-cache curl jq openssl
COPY factory-cd /usr/local/bin/
VOLUME /state
CMD ["factory-cd"]
