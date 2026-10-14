# Настройка GlitchTip для демо (manage.py shell): проект цели в организации factory и токен
# координатора (чтение и закрытие ошибок). Оповещения вебхуком не нужны: координатор сам
# опрашивает GlitchTip - входящих соединений нет. Повторный запуск безопасен.
# Вход: scripts/demo-up.sh ставит перед этим файлом строку APP.
# Выход: строки "dsn КЛЮЧ ПРОЕКТ" и "token ТОКЕН".
from bitfield.types import BitHandler

from apps.api_tokens.models import APIToken
from apps.organizations_ext.models import Organization
from apps.projects.models import Project, ProjectKey
from apps.users.models import User

# ruff: noqa: F821 - APP задаёт вход.
org = Organization.objects.get(name="factory")
owner = User.objects.filter(organizations_ext_organizationuser__organization=org).order_by("id").first()
project = Project.objects.filter(organization=org, name=APP).first()
if project is None:
    project = Project.objects.create(organization=org, name=APP, platform="node")
key = ProjectKey.objects.filter(project=project, is_active=True).order_by("id").first()
if key is None:
    key = ProjectKey.objects.create(project=project)
print("dsn", key.public_key, project.id)

token = APIToken.objects.filter(user=owner, label="coordinator").first()
if token is None:
    scopes = BitHandler(0, APIToken.scopes.keys())
    for s in ("project:read", "event:read", "event:write", "org:read"):
        setattr(scopes, s, True)
    token = APIToken.objects.create(user=owner, label="coordinator", scopes=scopes.mask)
print("token", token.token)
