# Портал документации из git (portal.sh): Zensical (MIT) собирает сайт из спецификаций,
# записей решений и вики репозиториев приложений.
FROM docker.io/library/python:3.13.15-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& pip install --no-cache-dir zensical==0.0.65 \
	&& useradd -u 1000 -m portal && mkdir -p /srv/portal && chown portal /srv/portal
COPY portal.sh /usr/local/bin/portal
USER portal
EXPOSE 8000
CMD ["portal"]
