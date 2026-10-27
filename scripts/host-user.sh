#!/bin/sh
# Пользователь для docker run, который пишет в смонтированные каталоги как их хозяин на хосте
# (node_modules, выгрузки): обычно uid:gid хоста. В Docker без root (rootless) хозяин хоста
# внутри контейнера - root, а uid хоста там - чужой подчинённый uid без прав на запись.
if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
	echo 0:0
else
	echo "$(id -u):$(id -g)"
fi
