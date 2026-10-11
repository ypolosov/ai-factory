# Выход заданий в интернет: прокси Squid (GPL-2.0) со списком разрешённых адресов.
# Docker заданий (agent-dind, ci-dind) живёт во внутренней сети без выхода наружу;
# наружу можно только через этот прокси и только по списку allowlist.txt.
FROM docker.io/library/alpine:3.24
RUN apk add --no-cache squid
COPY squid.conf allowlist.txt /etc/squid/
# Сразу от пользователя squid: тогда вывод контейнера принадлежит ему и журнал
# пишется в docker logs (после сброса прав из root Squid не может открыть /dev/stdout).
USER squid
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
