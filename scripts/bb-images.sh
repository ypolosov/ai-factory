#!/bin/sh
# bb-images.sh ОБРАЗ... - кладёт образы с хоста в реестр шагов Bitbucket (bb-registry):
# Docker заданий в интернет не ходит, а раннер Bitbucket всегда скачивает образ шага.
# Образ в шаге: 172.31.250.20:5000/<имя>:<тег>.
set -eu

registry=172.31.250.20:5000
dind=$(docker compose --profile bitbucket ps -q bb-dind)
[ -n "$dind" ] || {
	echo "bb-dind не запущен: docker compose --profile bitbucket up -d" >&2
	exit 1
}
for image in "$@"; do
	name=${image#docker.io/}
	name=${name#library/}
	docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
	docker save "$image" | docker exec -i "$dind" docker -H unix:///var/run/dind/docker.sock load -q >/dev/null
	docker exec "$dind" docker -H unix:///var/run/dind/docker.sock tag "$image" "$registry/$name"
	docker exec "$dind" docker -H unix:///var/run/dind/docker.sock push -q "$registry/$name" >/dev/null
	echo "$registry/$name"
done
