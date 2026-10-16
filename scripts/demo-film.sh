#!/bin/sh
# demo-film.sh [--only шаг,шаг] [--ctx /state/films/<время>/manifest.json] - прогон сценария
# съёмки видео-демо (docs/demo/film.yml): участники действуют через API под своими учётками,
# камера (Playwright без окна, образ factory/camera) снимает экраны. Клипы и манифест - в
# .state/films/<время>/ (рядом с ключами и входами камеры: трассы браузера хранят куки). Ключи и
# входы монтируются только для чтения. Перед съёмкой стенд сбрасывается (scripts/demo-reset.sh):
# прошлые дубли уходят из кадра. --ctx продолжает прерванный дубль с итогами из его манифеста -
# без сброса стенда. Запуск из корня репозитория после scripts/demo-up.sh.
set -eu

case " $* " in *" --ctx "*) ;; *) "$(dirname "$0")/demo-reset.sh" ;; esac
out=.state/films/$(date +%Y%m%d-%H%M%S)
mkdir -p "$out"
docker build -q -t factory/camera:stand -f images/camera/Dockerfile images >/dev/null
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e TZ="${TZ:-$(cat /etc/timezone 2>/dev/null || echo UTC)}" \
	-v "$PWD/docs/demo:/film:ro" -v "$PWD/.state:/state:ro" -v "$PWD/$out:/out" \
	factory/camera:stand /film/film.yml /out "$@"
echo "клипы: $out"
