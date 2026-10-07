# Развёртывание CodexNest

Эта инструкция описывает первый запуск CodexNest на Linux-сервере (в том числе
Raspberry Pi OS 64-bit) и дальнейшее обновление приложения. В результате сервер
работает как пользовательский `systemd`-сервис, а интерфейс доступен из браузера
и Android-приложения.

CodexNest рассчитан на одного владельца и локальный контур: сам хост, доверенную
частную LAN и приватную сеть WireGuard/Tailscale владельца. Доступ извне домашней
сети должен проходить только внутри WireGuard/Tailscale.

Никогда не публикуйте порт `4310` в интернете через port forwarding/UPnP,
публичный reverse proxy, публичный tunnel или правило cloud firewall. Даже при
наличии HTTPS сервер не рассчитан на публичную доступность. Owner token даёт
управление Codex, а сервис работает с правами того же Linux-пользователя, что и
Codex CLI, поэтому утечка token может открыть доступ к проектам и другим файлам
этого пользователя.

## Рекомендуемая установка через rolling GitHub Release

На Ubuntu или Debian (`amd64`/`arm64`) последнюю успешную CI-сборку ветки
`main` можно установить одной командой от обычного пользователя:

```bash
curl -fsSL https://github.com/petrovichest/nest-apps/releases/latest/download/install.sh | bash
```

Installer закреплён на том же проверенном commit, что серверы, web-клиенты и manifest в GitHub
Release. Он загрузит закреплённый Node.js в пользовательский каталог, соберёт
этот commit, создаст user-systemd services, owner token и versioned release с
symlink-ами `current`/`previous`. Существующие config, state и token при
повторном запуске сохраняются.

Rolling-версия назначается автоматически в формате
`<версия package.json>-<короткий commit>`, например `0.1.6-73e1842`. Одно и то
же значение используется в названии GitHub Release, manifest и Linux
installer.

Установка конкретной версии:

```bash
curl -fsSL https://github.com/petrovichest/nest-apps/releases/download/v0.1.6/install.sh | \
  bash -s -- --version 0.1.6
```

Codex CLI installer не устанавливает. Если CLI отсутствует, диагностический UI
всё равно запускается; после ручной установки и `codex login` выполните
`codexnest repair`.

Основные команды управления:

```bash
codexnest status
codexnest logs
codexnest doctor
codexnest repair
codexnest update
codexnest rollback
codexnest restart
```

Managed install слушает `0.0.0.0:4310`. Собственный origin браузера разрешается
динамически для LAN/VPN IP и приватного DNS. Installer не меняет firewall, не
настраивает VPN или HTTPS и не предназначен для публичного port forwarding.
Ограничьте входящие соединения локальной подсетью и/или интерфейсом приватного
WireGuard/Tailscale VPN; не разрешайте этот порт на публичном интерфейсе.

UI один раз проверяет обновления после подключения; повторные переподключения
только перечитывают локальное состояние updater без нового запроса к GitHub.
Ручная проверка также доступна в настройках. По умолчанию updater читает manifest
последней успешной CI-сборки ветки `main`, собирает указанный commit рядом с
текущей версией, атомарно переключает `current`, перезапускает приложение и
возвращает `previous`, если health-check не прошёл. Для обновлений только по
стабильным semver-релизам установите `CODEXNEST_UPDATE_CHANNEL=stable` в
`server.env`.

В daemon-режиме совместимые релизы могут обновляться во время активных turn:
updater сначала переводит только CodexNest в короткий drain, сохраняет state,
проверяет recovery protocol target-релиза и перезапускает Node.js-сервис, не
трогая Codex daemon. Health-check считается успешным только после восстановления
очередей и Team orchestration. Несовместимый релиз, stdio transport или
недоступный daemon требуют полностью завершённой работы. Первый переход с
версии, в которой recovery protocol ещё отсутствует, также выполняйте без
активных turn. Если после переключения новый процесс недоступен, updater не
делает автоматический rollback на старый несовместимый protocol, пока не может
доказать отсутствие риска для активной работы.

Оставшаяся часть документа описывает ручную и расширенную установку, включая
proxy, speech-to-text и reverse proxy.

### Переход существующей ручной установки

После публикации стабильного тега существующий чистый Git-checkout можно один
раз перевести на managed releases без запуска installer и без смены config,
state, token или systemd drop-ins:

```bash
deploy/adopt-existing.sh \
  --repo "$HOME/git/codex-nest" \
  --node "$HOME/.local/node-v24" \
  --dry-run

deploy/adopt-existing.sh \
  --repo "$HOME/git/codex-nest" \
  --node "$HOME/.local/node-v24"
```

Скрипт сначала собирает tagged release рядом с работающей версией и только затем
переключает user-systemd service. При неудачном restart или health-check прежние
`server.env` и базовый unit восстанавливаются автоматически.

## 1. Требования

На сервере должны быть установлены:

- 64-битный Linux с `systemd`;
- Git;
- Node.js 24 LTS и npm 10 или новее;
- Codex CLI;
- учётная запись Linux с доступом к папкам проектов.

Проверьте версии:

```bash
node --version
npm --version
codex --version
```

Команда должна вывести установленную версию в формате `codex-cli <версия>`.
CodexNest записывает её в health endpoint для диагностики, но не блокирует запуск
из-за несовпадения номера версии. Реальные ошибки запуска или RPC возвращаются
клиенту как ошибки app-server.

Все дальнейшие команды выполняйте от одного и того же обычного Linux-пользователя.
От него будут работать Codex CLI и сервис, поэтому не устанавливайте и не
авторизуйте Codex только под `root`.

Авторизуйте Codex и проверьте состояние входа:

```bash
codex login
codex login status
```

## 2. Получение и сборка приложения

Клонируйте репозиторий именно в `~/codex-nest`: этот путь использует пример
`systemd`-сервиса.

```bash
git clone git@github.com:petrovichest/nest-apps.git "$HOME/codex-nest"
cd "$HOME/codex-nest"
npm ci
npm run build
```

Сборка создаёт сервер в `apps/server/dist` и браузерный интерфейс в
`apps/client/dist`.

Перед первым production-запуском рекомендуется выполнить проверки:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

Обычные тесты не обращаются к OpenAI и не расходуют квоту. Команда
`npm run protocol:generate` нужна только при намеренном обновлении сгенерированных
TypeScript-типов и требует версию CLI из `apps/server/src/codex/PROTOCOL_VERSION`;
для обычной сборки и production-запуска она не выполняется.

## 3. Конфигурация

Создайте каталоги и скопируйте примеры:

```bash
mkdir -p "$HOME/.config/codexnest" "$HOME/.config/systemd/user"
cp deploy/systemd/codexnest.env.example "$HOME/.config/codexnest/server.env"
cp deploy/systemd/codexnest.service.example "$HOME/.config/systemd/user/codexnest.service"
chmod 600 "$HOME/.config/codexnest/server.env"
```

Узнайте реальные пути к исполняемым файлам:

```bash
command -v node
command -v codex
```

Откройте `~/.config/codexnest/server.env` и замените все значения `CHANGE_ME`.
В `CODEXNEST_CODEX_BIN` укажите результат `command -v codex`. Используйте полные
пути: `systemd` не подставляет `$HOME` и `~` в `EnvironmentFile`.

Production-пример включает `CODEXNEST_CODEX_TRANSPORT=daemon`. Один раз
установите и запустите штатный пользовательский daemon Codex от того же
пользователя, который запускает CodexNest:

```bash
codex app-server daemon bootstrap
codex app-server daemon version
```

Чтобы daemon автоматически запускался перед CodexNest после перезагрузки хоста,
установите systemd drop-in:

```bash
mkdir -p "$HOME/.config/systemd/user/codexnest.service.d"
cp deploy/systemd/codex-daemon.conf.example \
  "$HOME/.config/systemd/user/codexnest.service.d/codex-daemon.conf"
```

Основной unit и drop-in используют `KillMode=process`: при обновлении
останавливается только Node.js-процесс CodexNest, а запущенный через
`ExecStartPre` Codex daemon остаётся в работе вместе с активными turn'ами.

Если доступ к ChatGPT требует HTTP proxy, используйте fail-closed wrapper. Он
передаёт proxy только внутреннему клиенту Codex и отказывается запускать Codex,
если proxy-окружение отсутствует или противоречиво. Остальные процессы сервера
не получают эти переменные.

Скопируйте отдельный пример окружения, впишите адрес и учётные данные, затем
ограничьте права. Не добавляйте реальный файл с proxy-паролем в Git:

```bash
mkdir -p "$HOME/.config/codex"
cp deploy/systemd/codex-app-server.env.example "$HOME/.config/codex/app-server.env"
chmod 600 "$HOME/.config/codex/app-server.env"
```

В пользовательском `~/.codex/config.toml` включите поддержку системного proxy и
удаление proxy-переменных из окружения команд, запускаемых агентом. Если таблицы
уже существуют, добавьте ключи в существующие таблицы вместо создания дублей:

```toml
[features]
respect_system_proxy = true

[shell_environment_policy]
exclude = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
set = { HTTP_PROXY = "", HTTPS_PROXY = "", ALL_PROXY = "", NO_PROXY = "", http_proxy = "", https_proxy = "", all_proxy = "", no_proxy = "" }
```

Имена в `shell_environment_policy.exclude` сравниваются без учёта регистра,
поэтому правило также удаляет lowercase-варианты. Пустые значения в `set`
имеют приоритет и сохраняют прямое подключение для `unified_exec` в версиях,
которые повторно добавляют исходное окружение после `exclude`. `git`, `npm`,
`curl` и другие команды агента продолжат использовать прямое подключение.

Разместите wrapper раньше standalone-команды Codex в интерактивном `PATH`. Не
заменяйте `~/.local/bin/codex`: этот symlink принадлежит standalone-updater.

```bash
mkdir -p "$HOME/bin"
ln -sfn "$HOME/codex-nest/deploy/systemd/codex-proxied" "$HOME/bin/codex"
```

Добавьте `export PATH="$HOME/bin:$PATH"` в конец `~/.profile` и `~/.bashrc`, если
`$HOME/bin` ещё не стоит первым. Убедитесь, что новая интерактивная shell видит
wrapper:

```bash
command -v codex
```

Для CodexNest установите proxy-вариант systemd drop-in. В отличие от обычного
примера он не добавляет `EnvironmentFile` к Node.js-сервису:

```bash
cp deploy/systemd/codex-daemon-proxied.conf.example \
  "$HOME/.config/systemd/user/codexnest.service.d/codex-daemon.conf"
systemctl --user daemon-reload
```

Один раз остановите ранее запущенный daemon настоящим standalone-бинарником и
поднимите его через wrapper, чтобы app-server и updater унаследовали proxy:

```bash
"$HOME/.local/bin/codex" app-server daemon stop
"$HOME/bin/codex" app-server daemon bootstrap
"$HOME/bin/codex" app-server daemon version
```

Проверьте конфигурацию и сетевой WebSocket перед запуском CodexNest:

```bash
"$HOME/bin/codex" --strict-config doctor --json
```

В секции `network.websocket_reachability` ожидается успешный handshake `101
Switching Protocols`. Если proxy недоступен, Codex завершает соединение ошибкой
и не переключается на прямой маршрут.

После запуска CodexNest тот же proxy можно безопасно заменить в разделе
«Настройки → Codex и прокси». Интерфейс принимает `host:port`,
`host:port:user:password`, `user:password@host:port` и полные `http://` или
`https://` URL. Перед заменой новый адрес проверяется через `codex doctor`, а
при неудачном перезапуске предыдущий приватный env-файл восстанавливается.
Пароль не возвращается браузеру после сохранения. Проверка latest version,
обновление и перезапуск daemon также доступны в этой карточке; операции,
прерывающие daemon, блокируются до завершения активных turn.

CodexNest будет подключаться к нему по WebSocket через локальный Unix-сокет. При
перезапуске `codexnest.service` соединение закроется, а выполняющийся turn
останется в daemon; после старта CodexNest переподключится и заново откроет
активную задачу. Для локальной разработки без daemon оставьте
`CODEXNEST_CODEX_TRANSPORT=stdio` или не задавайте переменную.

Затем откройте `~/.config/systemd/user/codexnest.service`. Если репозиторий лежит
не в `~/codex-nest` или Node.js установлен не в `~/.local/node-v24`, исправьте
`WorkingDirectory` и `ExecStart` в соответствии с результатом `command -v node`.

Не включайте для пользовательского сервиса `PrivateTmp` или `ProtectSystem`.
На Linux Codex создаёт собственную песочницу через `bubblewrap`; внешний mount/user
namespace от этих директив может заблокировать создание вложенной песочницы.
`NoNewPrivileges=true` при этом следует оставить включённым.

### Вариант A: HTTP внутри приватного VPN или доверенной LAN

Это самый короткий путь для первого запуска. В `server.env` задайте:

```dotenv
CODEXNEST_HOST=0.0.0.0
CODEXNEST_PORT=4310
CODEXNEST_ALLOWED_ORIGINS=http://192.168.1.42:4310,http://localhost
```

Замените `192.168.1.42` на постоянный LAN-адрес или локальное имя сервера.
`http://localhost` нужен встроенному Android-клиенту.

Предпочтительный случай для HTTP — зашифрованный туннель WireGuard/Tailscale.
Прямой HTTP без VPN допустим только в полностью доверенной домашней сети, потому
что у него есть важные последствия:

- bearer token, промпты, ответы, вывод команд, пути к файлам и решения по
  approval передаются без шифрования;
- устройство, способное просматривать или изменять трафик LAN (например,
  скомпрометированный роутер или точка доступа, посторонний клиент Wi-Fi или
  участник атаки ARP spoofing), может перехватить token и повторно использовать
  его до ротации;
- bearer token даёт полномочия единственного владельца: позволяет читать
  сессии, запускать turn, отвечать на approval-запросы и менять глобальные
  разрешения Codex, включая `danger-full-access`;
- CORS и список `CODEXNEST_ALLOWED_ORIGINS` защищают браузер от чужого origin,
  но не шифруют сеть и не мешают небраузерному клиенту с украденным token.

Не используйте прямой HTTP в гостевой, общей, публичной или корпоративной Wi-Fi
сети. Не настраивайте проброс порта `4310` на роутере и не публикуйте его через
публичный tunnel. Ограничьте доступ доверенным устройствам и по возможности
вынесите их в отдельный SSID/VLAN. Для доступа вне доверенной LAN используйте
только приватную сеть WireGuard/Tailscale.

Если есть подозрение, что HTTP-трафик мог наблюдаться, немедленно выпустите новый
token командой ротации из раздела 4, затем проверьте недавние сессии и approval.

### Вариант B: HTTPS через приватный reverse proxy

Это рекомендуемый вариант, если внутри LAN/VPN нужен HTTPS. Reverse proxy и его
DNS-имя тоже должны быть доступны только из приватной LAN или WireGuard/Tailscale,
а не из публичного интернета. Оставьте сервер на loopback и укажите приватный
адрес:

```dotenv
CODEXNEST_HOST=127.0.0.1
CODEXNEST_PORT=4310
CODEXNEST_ALLOWED_ORIGINS=https://codexnest.example.com,http://localhost
```

Замените домен на свой. После первого запуска настройте Nginx по примеру
[`nginx/codexnest.conf.example`](./nginx/codexnest.conf.example) или Caddy по
примеру [`caddy/Caddyfile.example`](./caddy/Caddyfile.example). В обоих случаях
замените имя хоста и пути к сертификату, а затем проверьте конфигурацию прокси
перед перезагрузкой. Не используйте отключение TLS-проверки (`curl -k` или
accept-all certificate handler). Android-клиент доверяет системным центрам
сертификации и CA-сертификатам, которые владелец устройства установил вручную.
Для локального CA установите на Android только принадлежащий вам корневой
сертификат и используйте его исключительно для доверенных LAN/VPN-сервисов.

### Переменные окружения

| Переменная                       | Назначение                                        | Значение по умолчанию                         |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `CODEXNEST_HOST`                 | Адрес прослушивания                               | `127.0.0.1`                                   |
| `CODEXNEST_PORT`                 | HTTP/API порт                                     | `4310`                                        |
| `CODEXNEST_ALLOWED_ORIGINS`      | Разрешённые browser/Android origins через запятую | локальные origins для разработки              |
| `CODEXNEST_EMBED_ORIGINS`        | Сайты, которым разрешено встраивать окно          | встраивание запрещено                         |
| `CODEXNEST_STATE_PATH`           | Rollback JSON и внешний verifier токена           | `~/.local/state/codexnest/state.json`         |
| `CODEXNEST_DATABASE_PATH`        | Основная SQLite-база состояния                    | `state.sqlite` рядом с `CODEXNEST_STATE_PATH` |
| `CODEXNEST_CODEX_BIN`            | Полный путь к Codex CLI                           | `codex` из `PATH`                             |
| `CODEXNEST_CODEX_MANAGEMENT_BIN` | Путь к fail-closed wrapper для doctor/update      | `~/bin/codex`                                 |
| `CODEXNEST_CODEX_PROXY_ENV_FILE` | Приватный env-файл proxy для wrapper              | `~/.config/codex/app-server.env`              |
| `CODEXNEST_SERVER_ENV_FILE`      | Env-файл, обновляемый серверными настройками      | `~/.config/codexnest/server.env`              |
| `CODEXNEST_CODEX_TRANSPORT`      | `daemon` сохраняет активные turn при рестарте     | `stdio`                                       |
| `CODEXNEST_CLIENT_DIST`          | Собранный браузерный интерфейс                    | `apps/client/dist` относительно рабочей папки |
| `CODEXNEST_UPDATE_CHANNEL`       | Канал обновлений: `rolling` или `stable`          | `rolling`                                     |
| `CODEXNEST_LOG_LEVEL`            | Уровень логов Fastify                             | `info`                                        |
| `CODEXNEST_STT_PROVIDER`         | Глобальный режим: `local` или `openai`            | первый настроенный провайдер                  |
| `CODEXNEST_STT_LOCAL_URL`        | Endpoint локального STT-сервиса                   | локальный провайдер выключен                  |
| `CODEXNEST_STT_OPENAI_API_KEY`   | Отдельный API-ключ OpenAI для транскрипции        | OpenAI-провайдер выключен                     |
| `CODEXNEST_STT_OPENAI_MODEL`     | Модель OpenAI speech-to-text                      | `gpt-4o-transcribe`                           |
| `CODEXNEST_STT_LANGUAGE`         | ISO-код языка записи                              | `ru`                                          |
| `CODEXNEST_STT_REFINE_LOCAL`     | Улучшать локальный текст через Codex              | `true`                                        |
| `CODEXNEST_STT_REFINEMENT_MODEL` | Модель улучшения локального текста                | `gpt-5.6-luna`                                |
| `CODEXNEST_STT_TIMEOUT_MS`       | Timeout одного распознавания                      | `600000`                                      |

### Встраивание плавающим окном

CodexNest можно открыть поверх своего сайта (например, дашборда) отдельным
окном: его можно перетаскивать за заголовок, менять размер за края и углы,
свернуть, развернуть на весь экран и закрыть; положение запоминается. Окно
загружает полный интерфейс CodexNest во frame, поэтому функциональность та же.

1. Укажите origin страницы-хозяина без пути:
   `CODEXNEST_EMBED_ORIGINS=https://dashboard.example`. Без этой переменной
   сервер запрещает показ во frame (`frame-ancestors 'none'`).
2. Подключите загрузчик и откройте окно:

   ```html
   <script src="https://codexnest.example/embed.js"></script>
   <script>
     CodexNestEmbed.open({ src: "https://codexnest.example/", title: "Агент" });
   </script>
   ```

   Также доступны `CodexNestEmbed.close()`, `minimize()`, `isOpen()` и
   `setTheme("light" | "dark" | "system")` для рамки окна.

Встраивание не ослабляет границу безопасности: адрес CodexNest по-прежнему
должен быть доступен только из приватной сети или через шлюз страницы-хозяина,
который сам проверяет владельца. Не встраивайте CodexNest в публичный сайт.

### Speech-to-text

Активный провайдер и параметры распознавания общие для всех клиентов. Их можно
изменить в разделе «Настройки → Распознавание речи» или через переменные выше.
UI атомарно обновляет `server.env` и применяет значения без перезапуска; ручное
изменение файла применяется после перезапуска `codexnest.service`. API-ключ и
proxy credentials браузеру не возвращаются и не записываются в лог.

Для OpenAI добавьте `CODEXNEST_STT_OPENAI_API_KEY` в приватный `server.env`.
CodexNest поддерживает `gpt-4o-transcribe` и `gpt-4o-mini-transcribe`. Исходная
запись отправляется в Audio API одним запросом через тот же валидный proxy-файл,
что и Codex. Если proxy-файла нет, соединение прямое; повреждённый или доступный
посторонним файл блокирует запрос вместо скрытого перехода на прямое соединение.
API-ключ удаляется из окружения запускаемых Codex-процессов. Ввод нового ключа
через UI/API разрешён только по HTTPS или с локального подключения.

В режиме `local` CodexNest может после Whisper консервативно расставить
пунктуацию, регистр и исправить очевидные ошибки через изолированный поток Codex.
При ошибке или таймауте улучшения клиент получает исходный локальный текст.

Оба поддерживаемых локальных backend принимают `multipart/form-data` с записью и
языком через `POST /inference` и возвращают JSON с полем `text`. CodexNest
обращается к выбранному сервису только через общий адрес
`CODEXNEST_STT_LOCAL_URL`; обычно это
`http://127.0.0.1:8178/inference`. Выберите один из следующих сервисов и не
запускайте оба на одном порту одновременно.

#### Локальный backend A: whisper.cpp

Установите `cmake`, C++ compiler, `ffmpeg` и, при необходимости, OpenBLAS или
CUDA toolkit. Затем соберите протестированную версию `whisper.cpp`:

```bash
mkdir -p "$HOME/.local/opt" "$HOME/.local/share/codexnest"
git clone --branch v1.8.1 --depth 1 \
  https://github.com/ggml-org/whisper.cpp.git \
  "$HOME/.local/opt/whisper.cpp"
cd "$HOME/.local/opt/whisper.cpp"
cmake -B build -DWHISPER_BUILD_SERVER=ON
cmake --build build --config Release -j
./models/download-ggml-model.sh small
ln -sfn "$PWD/models/ggml-small.bin" \
  "$HOME/.local/share/codexnest/whisper-model.bin"
```

Профиль `small` подходит для CPU и Raspberry Pi. На NVIDIA-сервере соберите с
`-DGGML_CUDA=1`, загрузите `large-v3-turbo` и направьте symlink
`whisper-model.bin` на эту модель. Модель выбирается сервисом, а не клиентом.

Установите отдельный пользовательский сервис и проверьте его до включения в
CodexNest:

```bash
cp deploy/systemd/codexnest-stt.service.example \
  "$HOME/.config/systemd/user/codexnest-stt.service"
systemctl --user daemon-reload
systemctl --user enable --now codexnest-stt.service
systemctl --user status codexnest-stt.service
curl --fail --silent http://127.0.0.1:8178/
```

Пути в [`systemd/codexnest-stt.service.example`](./systemd/codexnest-stt.service.example)
можно менять: укажите фактические каталоги сборки `whisper.cpp` и файла модели в
`WorkingDirectory` и `ExecStart` до установки unit.

#### Локальный backend B: faster-whisper

В репозитории есть HTTP-адаптер
[`local-stt-server.py`](./local-stt-server.py) и пример user-systemd unit
[`systemd/codexnest-faster-whisper.service.example`](./systemd/codexnest-faster-whisper.service.example).
Создайте отдельный virtual environment и установите backend:

```bash
mkdir -p "$HOME/.local/share/local-stt"
python3 -m venv "$HOME/.local/share/local-stt/.venv"
"$HOME/.local/share/local-stt/.venv/bin/python" -m pip install --upgrade pip faster-whisper
```

Разместите совместимую локальную CTranslate2-модель в выбранном каталоге. Затем
скопируйте и отредактируйте unit:

```bash
cp deploy/systemd/codexnest-faster-whisper.service.example \
  "$HOME/.config/systemd/user/codexnest-faster-whisper.service"
systemctl --user edit --full codexnest-faster-whisper.service
```

В unit задайте фактические значения трёх путей: `WorkingDirectory` должен
указывать на checkout CodexNest с `deploy/local-stt-server.py`, первый путь в
`ExecStart` — на Python созданного venv, а значение `--model` — на каталог
локальной CTranslate2-модели. При необходимости измените `--threads`. Примерные
пути `%h/git/codex-nest`, `%h/.local/share/local-stt/.venv` и
`%h/.local/share/local-stt/whisper-codeswitch/ct2_int8_float16` не обязательны.

Запустите и проверьте сервис:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codexnest-faster-whisper.service
systemctl --user status codexnest-faster-whisper.service
curl --fail --silent http://127.0.0.1:8178/health
```

После проверки любого из двух backend добавьте один и тот же endpoint в
`server.env`:

```dotenv
CODEXNEST_STT_LOCAL_URL=http://127.0.0.1:8178/inference
CODEXNEST_STT_PROVIDER=local
CODEXNEST_STT_REFINE_LOCAL=true
CODEXNEST_STT_REFINEMENT_MODEL=gpt-5.6-luna
```

Запись ограничена пятью минутами и 24 MiB. Android-клиент запрашивает системное
разрешение микрофона. Браузеру нужен secure context: HTTPS либо localhost;
страница, открытая по обычному LAN HTTP-адресу, не получит доступ к микрофону.

Android-клиент получает фоновые уведомления напрямую через существующий WebSocket
CodexNest. Сторонний push-провайдер и дополнительные серверные credentials не
используются. Для надёжной работы Android показывает
постоянное низкоприоритетное уведомление foreground service.

Браузерный интерфейс использует тот же WebSocket для системных уведомлений о
завершении задач, ошибках и запросах решения. Разрешение включается в разделе
«Настройки → Уведомления браузера» или в диалоге при первом открытии приложения.
CodexNest не блокирует уведомления при HTTP-
подключении, но браузер должен предоставлять Notifications API для такого origin;
часть браузеров разрешает его только по HTTPS. Внешний push-провайдер не
используется, поэтому вкладка должна оставаться открытой или свёрнутой; после
полного закрытия браузера доставка не гарантируется.

## 4. Создание access token

Загрузите production-конфигурацию в текущую оболочку и создайте токен владельца:

```bash
set -a
. "$HOME/.config/codexnest/server.env"
set +a
cd "$HOME/codex-nest"
npm run --silent auth:generate -w @codexnest/server
```

Команда выводит bearer token один раз. Сохраните его в менеджере паролей: в
файле состояния хранится только SHA-256 verifier, восстановить исходный токен из
него нельзя.

Для отзыва старого токена и выпуска нового выполните:

```bash
npm run --silent auth:generate -w @codexnest/server -- --rotate
```

После ротации все подключённые клиенты должны войти с новым токеном. Работающий
сервер подхватывает новый verifier из файла состояния без полного redeploy.

## 5. Запуск systemd-сервиса

Разрешите пользовательскому сервису работать после выхода из SSH-сессии, затем
запустите его:

```bash
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now codexnest.service
systemctl --user status codexnest.service
```

В daemon-режиме также проверьте отдельный app-server:

```bash
codex app-server daemon version
```

Посмотреть текущие логи:

```bash
journalctl --user -u codexnest.service -n 100 --no-pager
```

Следить за логами в реальном времени:

```bash
journalctl --user -u codexnest.service -f
```

## 6. Проверка и первый вход

На самом сервере проверьте health endpoint:

```bash
curl --fail --silent --show-error http://127.0.0.1:4310/api/v1/health
```

Исправный ответ содержит:

```json
{
  "status": "ok",
  "appServer": {
    "state": "ready",
    "installedVersion": "0.145.0",
    "message": null
  }
}
```

В ответе будут и дополнительные поля. Если `status` равен `degraded`, сначала
посмотрите журнал сервиса.

Откройте с другого устройства:

- для варианта A — `http://192.168.1.42:4310`;
- для варианта B — `https://codexnest.example.com`.

На экране подключения укажите этот же адрес сервера и созданный bearer token.
Затем нажмите «Добавить проект» и укажите абсолютный путь к уже существующей
папке на сервере, например `/home/pi/git/my-project`. Пользователь сервиса должен
иметь права на чтение и запись в эту папку.

Инструкция по сборке и установке Android APK находится в
[`apps/client/android/README.md`](../apps/client/android/README.md).

## 7. Обновление

Развёртывайте обновления только через Git. После того как изменения закоммичены
и отправлены в remote, выполните на сервере:

```bash
cd "$HOME/codex-nest"
git pull --ff-only
npm ci
npm run build
npm run typecheck
npm test
systemctl --user restart codexnest.service
curl --fail --silent --show-error http://127.0.0.1:4310/api/v1/health
```

Не копируйте отдельные файлы приложения на сервер вручную. Если менялись unit-файл
или `server.env`, обновите их отдельно из соответствующих `.example`, проверьте
локальные значения и выполните `systemctl --user daemon-reload` перед restart.

## 8. Резервная копия

Остановите сервис, чтобы завершить checkpoint, и скопируйте SQLite-базу вместе с
rollback JSON:

```bash
systemctl --user stop codexnest.service
cp "$HOME/.local/state/codexnest/state.json" <КАТАЛОГ-РЕЗЕРВНЫХ-КОПИЙ>/state.json
cp "$HOME/.local/state/codexnest/state.sqlite" <КАТАЛОГ-РЕЗЕРВНЫХ-КОПИЙ>/state.sqlite
systemctl --user start codexnest.service
```

Основным источником состояния служит `state.sqlite`; `state.json` экспортируется
при штатной остановке для rollback на предыдущую версию. В них находятся verifier
токена, список проектов, read/pin/outcome metadata и регистрации устройств. Промпты,
ответы и вывод команд там не хранятся. История Codex остаётся в `~/.codex` и должна
резервироваться отдельно.

## 9. Типовые проблемы

- **`status: degraded`.** Проверьте `codex --version` именно от пользователя
  сервиса, значение `CODEXNEST_CODEX_BIN` и журнал сервиса. Номер версии сам по
  себе запуск не блокирует.
- **`status: degraded` в daemon-режиме.** Выполните
  `codex app-server daemon version`. Если control socket отсутствует, повторите
  `codex app-server daemon bootstrap` от пользователя сервиса.
- **Сервис завершается с `203/EXEC`.** Путь к Node.js в `ExecStart` неверен.
  Подставьте абсолютный результат `command -v node`.
- **`403 Origin not allowed`.** Добавьте точный origin клиента, включая схему и
  порт, в `CODEXNEST_ALLOWED_ORIGINS`, затем перезапустите сервис.
- **Интерфейс не открывается, но health endpoint работает.** Убедитесь, что
  `npm run build` создал `apps/client/dist` и `WorkingDirectory` указывает на корень
  репозитория.
- **Проект не добавляется.** Путь должен существовать на сервере, быть абсолютным
  и быть доступным пользователю, от которого работает сервис.
- **Codex видит другой логин или конфигурацию.** Повторите `codex login status` от
  того же пользователя. CodexNest использует его `~/.codex` и окружение.

## Android release

Для подписанной APK-сборки следуйте
[`apps/client/android/README.md`](../apps/client/android/README.md). Signing
keystore и пароли остаются вне Git. После сборки проверьте подпись и создайте
checksum:

```bash
cd "$HOME/codex-nest/apps/client/android"
apksigner verify --verbose app/build/outputs/apk/release/app-release.apk
shasum -a 256 app/build/outputs/apk/release/app-release.apk > CodexNest-1.0.apk.sha256
```

Перед релизом проверьте чистую установку и обновление APK, подключение по выбранной
схеме HTTP/HTTPS, уведомления в foreground/background и восстановление соединения
после обычного завершения процесса и перезагрузки устройства. Android force-stop
блокирует foreground service до следующего ручного запуска приложения.
