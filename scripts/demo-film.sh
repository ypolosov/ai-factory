#!/bin/sh
# demo-film.sh [--only шаг,шаг] - прогон сценария съёмки видео-демо (docs/demo/film.yml): участники
# действуют через API под своими учётками, камера (Playwright без окна, образ factory/camera)
# снимает экраны. Клипы и манифест - в .state/films/<время>/ (рядом с ключами и входами камеры:
# трассы браузера хранят куки). Ключи и входы монтируются только для чтения.
# Перед съёмкой стенд сбрасывается (scripts/demo-reset.sh): прошлые дубли уходят из кадра.
# Запуск из корня репозитория после scripts/demo-up.sh.
set -eu

"$(dirname "$0")/demo-reset.sh"
out=.state/films/$(date +%Y%m%d-%H%M%S)
mkdir -p "$out"
docker build -q -t factory/camera:stand -f images/camera/Dockerfile images >/dev/null
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD/docs/demo:/film:ro" -v "$PWD/.state:/state:ro" -v "$PWD/$out:/out" \
	factory/camera:stand /film/film.yml /out "$@"
echo "клипы: $out"
