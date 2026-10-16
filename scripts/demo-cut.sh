#!/bin/sh
# demo-cut.sh КАТАЛОГ_ДУБЛЯ [ВИДЕО.mp4] - черновая склейка дубля видео-демо: клипы камеры в порядке
# манифеста (manifest.json, scripts/demo-film.sh), у каждого - подпись внизу кадра. Карточки глав уже
# внутри клипов. Discord в склейку не входит: его снимают записью окна (OBS) и вставляют при монтаже.
# Нужны ffmpeg и шрифт DejaVu Sans (кириллица). По умолчанию - КАТАЛОГ_ДУБЛЯ/draft.mp4.
# Пример: scripts/demo-cut.sh .state/films/20261016-152532
set -eu

dir=${1:?использование: demo-cut.sh КАТАЛОГ_ДУБЛЯ [ВИДЕО.mp4]}
out=${2:-$dir/draft.mp4}
font=${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}
[ -s "$dir/manifest.json" ] || {
	echo "нет $dir/manifest.json - это не каталог дубля" >&2
	exit 2
}
[ -s "$font" ] || {
	echo "нет шрифта $font (FONT=путь к шрифту с кириллицей)" >&2
	exit 2
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Клип -> mp4 одного вида (1280x720, 30 кадров) с подписью из файла: текст подписи не нужно экранировать.
n=0
jq -r '.clips[] | [.file, .caption] | @tsv' "$dir/manifest.json" | while IFS="$(printf '\t')" read -r file caption; do
	n=$((n + 1))
	part=$(printf '%s/%03d.mp4' "$tmp" "$n")
	printf '%s' "$caption" >"$tmp/caption-$n.txt"
	ffmpeg -nostdin -v error -y -i "$dir/$file" \
		-vf "scale=1280:720,fps=30,drawtext=fontfile=$font:textfile=$tmp/caption-$n.txt:fontsize=26:fontcolor=white:box=1:boxcolor=0x14111F@0.78:boxborderw=14:x=24:y=h-th-40" \
		-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -an "$part"
	printf "file '%s'\n" "$part" >>"$tmp/list.txt"
	echo "клип $n: $file"
done
ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$tmp/list.txt" -c copy "$out"
echo "склейка: $out ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out" | cut -d. -f1) с)"
