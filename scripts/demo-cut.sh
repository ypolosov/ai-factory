#!/bin/sh
# demo-cut.sh КАТАЛОГ_ДУБЛЯ [КАТАЛОГ...] [ВИДЕО.mp4] - черновая склейка дубля видео-демо: клипы
# камеры в порядке манифеста (manifest.json, scripts/demo-film.sh), у каждого - подпись внизу кадра.
# Несколько каталогов - прерванный дубль и его продолжение (--ctx): клипы идут по порядку каталогов.
# Карточки глав уже внутри клипов. Discord в склейку не входит: его снимают записью окна (OBS) и
# вставляют при монтаже. Нужны ffmpeg и шрифт DejaVu Sans (кириллица). По умолчанию - draft.mp4 в
# первом каталоге.
# Пример: scripts/demo-cut.sh .state/films/20261016-174550 .state/films/20261016-174550-b
set -eu

[ $# -ge 1 ] || {
	echo "использование: demo-cut.sh КАТАЛОГ_ДУБЛЯ [КАТАЛОГ...] [ВИДЕО.mp4]" >&2
	exit 2
}
out=$1/draft.mp4
dirs=
for a in "$@"; do
	case $a in *.mp4) out=$a ;; *)
		[ -s "$a/manifest.json" ] || {
			echo "нет $a/manifest.json - это не каталог дубля" >&2
			exit 2
		}
		dirs="$dirs $a"
		;;
	esac
done
font=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}
[ -s "$font" ] || {
	echo "нет шрифта $font (FONT=путь к шрифту с кириллицей)" >&2
	exit 2
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Клип -> mp4 одного вида (1280x720, 30 кадров) с подписью из файла: текст подписи не нужно экранировать.
# shellcheck disable=SC2086 # каталоги дубля - без пробелов в именах
for dir in $dirs; do jq -r --arg d "$dir" '.clips[] | [$d + "/" + .file, .caption] | @tsv' "$dir/manifest.json"; done >"$tmp/clips"
n=0
while IFS="$(printf '\t')" read -r file caption; do
	n=$((n + 1))
	part=$(printf '%s/%03d.mp4' "$tmp" "$n")
	printf '%s' "$caption" >"$tmp/caption-$n.txt"
	ffmpeg -nostdin -v error -y -i "$file" \
		-vf "scale=1280:720,fps=30,drawtext=fontfile=$font:textfile=$tmp/caption-$n.txt:fontsize=26:fontcolor=white:box=1:boxcolor=0x14111F@0.78:boxborderw=14:x=24:y=h-th-40" \
		-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -an "$part"
	printf "file '%s'\n" "$part" >>"$tmp/list.txt"
	echo "клип $n: $file"
done <"$tmp/clips"
ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$tmp/list.txt" -c copy "$out"
echo "склейка: $out ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out" | cut -d. -f1) с)"
