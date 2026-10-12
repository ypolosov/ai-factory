# Настройка GlitchTip стенда (manage.py shell): администратор, организация factory, по
# проекту на приложение из DEPLOY_APPS с оповещением о каждой новой ошибке вебхуком в
# errbridge, токен чтения событий для errbridge. Повторный запуск безопасен.
# Вход: scripts/lib.sh ставит перед этим файлом строки EMAIL, PASSWORD, APPS, HOOK_TOKEN
# (секреты - через стандартный ввод, не через аргументы команд).
# Выход: строки "dsn ПРИЛОЖЕНИЕ КЛЮЧ ПРОЕКТ" и "token ТОКЕН".
from bitfield.types import BitHandler

from apps.alerts.models import AlertRecipient, ProjectAlert
from apps.api_tokens.models import APIToken
from apps.organizations_ext.models import Organization, OrganizationUserRole
from apps.projects.models import Project, ProjectKey
from apps.users.models import User

# ruff: noqa: F821 - EMAIL, PASSWORD, APPS, HOOK_TOKEN задаёт вход.
HOOK = "http://errbridge:8000/glitchtip?repo={repo}&token={token}"

user = User.objects.filter(email=EMAIL).first()
if user is None:
    user = User.objects.create_superuser(email=EMAIL, password=PASSWORD)
org = Organization.objects.filter(name="factory").first()
if org is None:
    org = Organization.objects.create(name="factory")
if not org.organization_users.filter(user=user).exists():
    org.add_user(user, role=OrganizationUserRole.OWNER)

for entry in APPS.split():
    repo = entry.split("=", 1)[0]
    app = repo.rsplit("/", 1)[-1]
    project = Project.objects.filter(organization=org, name=app).first()
    if project is None:
        project = Project.objects.create(organization=org, name=app, platform="node")
    key = ProjectKey.objects.filter(project=project, is_active=True).order_by("id").first()
    if key is None:
        key = ProjectKey.objects.create(project=project)
    print("dsn", app, key.public_key, project.id)
    # Одно событие новой ошибки - оповещение (о каждой ошибке GlitchTip оповещает один раз).
    alert, _ = ProjectAlert.objects.get_or_create(
        project=project, name="factory-errbridge", defaults={"timespan_minutes": 1, "quantity": 1}
    )
    url = HOOK.format(repo=repo, token=HOOK_TOKEN)
    AlertRecipient.objects.filter(alert=alert).exclude(recipient_type="webhook", url=url).delete()
    AlertRecipient.objects.get_or_create(alert=alert, recipient_type="webhook", url=url)

token = APIToken.objects.filter(user=user, label="errbridge").first()
if token is None:
    scopes = BitHandler(0, APIToken.scopes.keys())
    setattr(scopes, "event:read", True)
    token = APIToken.objects.create(user=user, label="errbridge", scopes=scopes.mask)
print("token", token.token)
