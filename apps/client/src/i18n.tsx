import { application, applicationText } from "./application";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { UiLanguage } from "@codexnest/protocol";

const LANGUAGE_KEY = `${application.storagePrefix}.uiLanguage`;
const LEGACY_INSTALLATION_KEYS = [
  `${application.storagePrefix}.serverUrl`,
  `${application.storagePrefix}.theme`,
  `${application.storagePrefix}.sidebarSide`,
  `${application.storagePrefix}.projectListDirection`,
  `${application.storagePrefix}.sessionListMode`,
  `${application.storagePrefix}.layoutDefaultsVersion`,
  `${application.storagePrefix}.notificationPromptDismissed`,
];

const ENGLISH: Record<string, string> = {
  "Аккаунтов: {{count}}": "Accounts: {{count}}",
  Автопереключение: "Auto-switch accounts",
  "При лимите — другой доступный аккаунт.":
    "Switch to an available account when the quota runs out.",
  "Прогрев лимитов": "Warm up limits",
  "Запускать простаивающее 5-часовое окно коротким запросом.":
    "Start an idle 5-hour window with a short request.",
  "Тариф неизвестен": "Plan unknown",
  "Войдите в аккаунт, чтобы получить лимиты.": "Sign in to see the account quotas.",
  "Не удалось получить лимиты": "Could not get quotas",
  "Показаны последние данные.": "Showing the latest available data.",
  "Получаем лимиты…": "Fetching quotas…",
  "Лимиты ещё не получены.": "Quotas have not been fetched yet.",
  "Лимит недоступен": "Quota unavailable",
  "Остаток лимитов": "Quota remaining",
  "Модель сессии": "Session model",
  Войти: "Sign in",
  "Автоматическое переключение": "Automatic account switching",
  "Авторизовано аккаунтов: {{count}}": "Signed-in accounts: {{count}}",
  "Версия CLI недоступна": "CLI version unavailable",
  "Добавить аккаунт": "Add account",
  "Добавьте аккаунт Claude": "Add a Claude account",
  "Войдите через приложение и настройте подключение для аккаунта.":
    "Sign in through the app and configure the account connection.",
  "При ошибке лимита выбираем аккаунт с наибольшим остатком на 5 часов. Аккаунты с исчерпанным недельным лимитом пропускаются.":
    "When a quota error occurs, choose the account with the most remaining 5-hour quota. Accounts with exhausted weekly quotas are skipped.",
  "Загружаем аккаунты…": "Loading accounts…",
  "Обновить лимиты аккаунтов": "Refresh account quotas",
  "Обновить лимиты": "Refresh quotas",
  "Без авторизации": "Not signed in",
  "Аккаунт без авторизации": "Account not signed in",
  Авторизован: "Signed in",
  Используется: "In use",
  "Нужен вход": "Sign-in required",
  "Недельный лимит": "Weekly quota exhausted",
  "Лимит на 5 часов": "5-hour quota exhausted",
  "Ошибка подключения": "Connection error",
  "Действия аккаунта {{email}}": "Actions for {{email}}",
  "Использовать аккаунт": "Use account",
  "Войти заново": "Sign in again",
  "Войти в Claude": "Sign in to Claude",
  "Удалить аккаунт": "Remove account",
  "Удалить аккаунт {{email}}? История чатов сохранится.":
    "Remove account {{email}}? Chat history will be kept.",
  Настроить: "Configure",
  "5 часов": "5 hours",
  "7 дней": "7 days",
  "Осталось {{percent}}%": "{{percent}}% remaining",
  "Сброс: {{time}}": "Resets: {{time}}",
  "Время сброса неизвестно": "Reset time unknown",
  "Лимиты обновлены в {{time}}": "Quotas refreshed at {{time}}",
  "Не удалось обновить лимиты. Показаны последние полученные данные.":
    "Could not refresh quotas. Showing the latest available data.",
  "Проверьте подключение в настройках аккаунта.": "Check the connection in account settings.",
  "Не удалось загрузить аккаунты Claude. Повторите обновление.":
    "Could not load Claude accounts. Try refreshing again.",
  "Не удалось изменить настройки аккаунтов Claude.": "Could not change Claude account settings.",
  "Через прокси": "Use proxy",
  "Без прокси": "No proxy",
  "Тип прокси": "Proxy type",
  Адрес: "Address",
  "Адрес недоступен": "Address unavailable",
  Логин: "Username",
  "Логин: {{username}}": "Username: {{username}}",
  Пароль: "Password",
  "Подключение аккаунта": "Account connection",
  "Текущее подключение: {{connection}}": "Current connection: {{connection}}",
  "Сначала настройте подключение. Почта аккаунта появится после входа в Claude.":
    "Configure the connection first. The account email will appear after signing in to Claude.",
  "Вставьте новый прокси, чтобы изменить подключение": "Paste a new proxy to change the connection",
  "Вставьте прокси в любом формате": "Paste a proxy in any format",
  "Вставьте строку как получили от провайдера — разберём автоматически.":
    "Paste the line as received from your provider. It will be parsed automatically.",
  "Не удалось распознать прокси. Проверьте адрес и порт в строке.":
    "Could not parse the proxy. Check the address and port in the line.",
  "Выберите правильный разбор прокси": "Choose the correct proxy interpretation",
  "Прокси распознан": "Proxy recognized",
  "Показать прокси": "Show proxy",
  "Скрыть прокси": "Hide proxy",
  "Проверить прокси": "Test proxy",
  "Проверить подключение": "Test connection",
  "Подключение доступно": "Connection available",
  "Подключение доступно · {{latency}} мс": "Connection available · {{latency}} ms",
  "Подключение недоступно. Проверьте адрес, порт, логин и пароль прокси.":
    "Connection unavailable. Check the proxy address, port, username, and password.",
  "Не удалось проверить подключение через прокси.": "Could not test the proxy connection.",
  "Запросы Claude Code для этого аккаунта будут идти через выбранный прокси.":
    "Claude Code requests for this account will use the selected proxy.",
  "Запросы Claude Code для этого аккаунта будут идти без прокси.":
    "Claude Code requests for this account will use a direct connection.",
  "Сохранить подключение": "Save connection",
  "Перейти к входу": "Continue to sign in",
  "Подключаем…": "Connecting…",
  "Не удалось сохранить подключение аккаунта.": "Could not save the account connection.",
  "Не удалось начать вход. Проверьте подключение и попробуйте снова.":
    "Could not start sign-in. Check the connection and try again.",
  "Откройте страницу Claude и войдите в нужный аккаунт. Вернитесь сюда, чтобы завершить подключение.":
    "Open the Claude page and sign in to the account you want. Return here to finish connecting.",
  "Открыть страницу входа": "Open sign-in page",
  "Скопировать ссылку": "Copy link",
  "Ссылка скопирована": "Link copied",
  "Не удалось скопировать ссылку.": "Could not copy the link.",
  "Не удалось открыть страницу входа. Скопируйте ссылку и откройте её в браузере.":
    "Could not open the sign-in page. Copy the link and open it in your browser.",
  "Ожидаем код авторизации…": "Waiting for authorization code…",
  "Проверяем авторизацию…": "Checking sign-in…",
  "Вход выполнен": "Signed in",
  "Вход не завершён. Начните заново.": "Sign-in was not completed. Start again.",
  "Вход отменён": "Sign-in cancelled",
  "Готовим страницу входа…": "Preparing sign-in page…",
  "Начать вход заново": "Start sign-in again",
  "Скопируйте выданный Claude код целиком и вставьте сюда.":
    "Copy the complete code provided by Claude and paste it here.",
  "Код авторизации": "Authorization code",
  "Вставьте код из браузера": "Paste the code from your browser",
  "Подтвердить код": "Confirm code",
  "Не удалось подтвердить код. Вставьте его целиком или начните вход заново.":
    "Could not confirm the code. Paste the complete code or start sign-in again.",
  "Не удалось проверить вход. Повторяем проверку…": "Could not check sign-in. Trying again…",
  "Вход выполнен. Не удалось обновить список аккаунтов; закройте окно и нажмите обновление.":
    "Signed in. Could not refresh the account list; close this window and select Refresh.",
  "После входа покажем почту и лимиты аккаунта.":
    "After sign-in, the account email and quotas will appear.",
  "Ожидаем аккаунт с доступными лимитами": "Waiting for an account with available quota",
  "Переключаем аккаунт и продолжаем задачу": "Switching accounts and continuing the task",
  "Не удалось продолжить задачу после переключения аккаунта":
    "Could not continue the task after switching accounts",
  "Нет аккаунта с доступной квотой. Ожидаем восстановления лимитов.":
    "No account has available quota. Waiting for quotas to recover.",
  "Переключаем аккаунт и продолжаем незавершённую задачу…":
    "Switching accounts and continuing the unfinished task…",
  "Не удалось продолжить сессию после переключения аккаунта.":
    "Could not continue the session after switching accounts.",
  "Названия во всех проектах, включая архив":
    "Titles across all projects, including archived sessions",
  "Настройте URL локального STT, чтобы включить микрофон.":
    "Configure the local STT URL to enable the microphone.",
  "Это приложение подключается к ClaudeNest": "This application connects to ClaudeNest",
  "Возникла ошибка перегрузки модели. Продолжаем попытки — следующая через {{duration}}":
    "The model is at capacity. Retrying — next attempt in {{duration}}",
  "Возникла ошибка перегрузки модели. Продолжаем попытки…": "The model is at capacity. Retrying…",
  "Перегрузка модели": "Model at capacity",
  "Ответы подтверждены": "Answers confirmed",
  "Распознавание ответов": "Answer transcription",
  "Отправляем ответы": "Sending answers",
  "Готовим ответы": "Preparing answers",
  "{{done}} из {{total}} записей": "{{done}} of {{total}} recordings",
  "Готовые записи": "Completed recordings",
  "Добавляем текст": "Adding text",
  "Загружаем запись": "Uploading recording",
  "Запись {{number}}": "Recording {{number}}",
  "Отправим ответы после распознавания всех записей.":
    "Answers will be sent when all recordings are transcribed.",
  "Вернуться к редактированию": "Return to editing",
  Шрифты: "Fonts",
  "Основной интерфейс": "Main interface",
  "Проекты · Настройки": "Projects \u00b7 Settings",
  "Сообщения и поля ввода": "Messages and input fields",
  "Напишите сообщение": "Write a message",
  "Описания и пояснения": "Descriptions and explanations",
  "Настройки на этом устройстве": "Settings on this device",
  "Код, логи и таблицы": "Code, logs and tables",
  "Метаданные и компактные действия": "Metadata and compact actions",
  "Сегодня, 12:30 · 3 файла": "Today, 12:30 \u00b7 3 files",
  "Мелкие индикаторы": "Small indicators",
  "Заголовки разделов": "Section headings",
  "Заголовки диалогов и пустых состояний": "Dialog and empty state headings",
  "Заголовок экрана подключения": "Connection screen heading",
  "Каждый размер настраивается отдельно. Изменения видны сразу и сохраняются на этом устройстве.":
    "Adjust each size independently. Changes appear immediately and are saved on this device.",
  "Вернуть стандартные размеры": "Restore default font sizes",
  "Сбросить размер: {{name}}": "Reset size: {{name}}",
  "Стандартный размер: {{size}} px": "Default size: {{size}} px",
  "Вставленный текст": "Pasted text",
  "Удалить вставленный текст": "Remove pasted text",
  "Исходный вставленный текст": "Pasted text source",
  "Содержимое вставки": "Pasted content",
  "Редактировать вставленный текст": "Edit pasted text",
  "Скопировать вставленный текст": "Copy pasted text",

  "Поиск недоступен в этой версии Codex или для этой истории.":
    "Search is unavailable in this Codex version or for this history.",
  "Поиск по диалогам": "Search conversations",
  "Сообщения и названия во всех проектах, включая архив":
    "Messages and titles across all projects, including archives",
  "Текст для поиска": "Search text",
  "Что вы помните из диалога?": "What do you remember from the conversation?",
  Найти: "Search",
  "К результатам": "Back to results",
  "Открыть диалог": "Open conversation",
  "Совпадение найдено в названии или фрагмент больше недоступен. Можно открыть диалог.":
    "The title matched, or the excerpt is no longer available. You can open the conversation.",
  "Ищем…": "Searching…",
  "Не в архиве": "Not archived",
  "Совпадений нет": "No matches",
  "Введите фразу и нажмите «Найти». Поиск не включает технические журналы инструментов.":
    "Enter a phrase and select Search. Technical tool logs are not searched.",
  "Не удалось выполнить поиск": "Search failed",
  "Фрагмент из истории": "Excerpt from history",
  "К текущему диалогу": "Back to current conversation",
  "Сервер перезапущен. Повторите поиск, чтобы открыть фрагмент.":
    "The server restarted. Search again to open the excerpt.",
  "Не удалось загрузить фрагмент": "Could not load the excerpt",
  "История изменилась. Повторите поиск.": "History changed. Search again.",
  "Найденное сообщение больше недоступно. Можно вернуться к текущему диалогу.":
    "The matching message is no longer available. You can return to the current conversation.",
  "Не сообщено": "Not reported",
  "Модель в Codex": "Model in Codex",
  "Усилие в Codex": "Reasoning effort in Codex",
  "Приём сообщений": "Direct input",
  "Изменения Git": "Git changes",
  Выполнение: "Execution",
  Активность: "Activity",
  Усилие: "Reasoning effort",
  Доступен: "Available",
  "Временно недоступен": "Temporarily unavailable",
  "Codex временно не принимает сообщения": "Codex is temporarily not accepting messages",
  "Codex временно не принимает сообщения. Черновик и очередь сохранены.":
    "Codex is temporarily not accepting messages. Your draft and queue are preserved.",
  "Codex пока не принимает сообщения в эту сессию. Черновик и очередь сохранены.":
    "Codex is not currently accepting messages in this session. Your draft and queue are preserved.",
  "Проверить снова": "Check again",
  "Настройки, сообщённые Codex; не модель конкретного ответа. Ваш выбор применится при следующей отправке.":
    "Settings reported by Codex, not the model used for a specific answer. Your selection applies on the next send.",
  "В Codex: {{model}} · {{effort}}": "In Codex: {{model}} · {{effort}}",
  "Вопросы Codex": "Codex questions",
  "Можно ответить, пока Codex работает": "You can reply while Codex works",
  "Ответ доставлен Codex": "Reply delivered to Codex",
  "Ответ принят сервером — передаём Codex": "Reply accepted by the server — sending to Codex",
  "Ответ сохранён на устройстве — ожидает отправки": "Reply saved on this device — waiting to send",
  "Не удалось отправить ответ": "Could not send the reply",
  Ответить: "Reply",
  "Не удалось загрузить конфигурацию": "Failed to load configuration",
  "Браузер не выдал разрешение. Попробуйте ещё раз.":
    "The browser did not grant permission. Try again.",
  "Не удалось запросить разрешение у браузера": "Failed to request permission from the browser",
  "Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.":
    "Insecure HTTP connection: data can be intercepted on the LAN.",
  "Закрыть меню": "Close menu",
  "{{error}}. Серверные задачи продолжат выполняться.":
    "{{error}}. Server tasks will continue running.",
  Повторить: "Retry",
  "Повторить сохранённую запись": "Retry saved recording",
  "Восстанавливаем сохранённую запись…": "Recovering saved recording…",
  "Получаем состояние Codex…": "Loading Codex state…",
  "Разрешить уведомления?": "Allow notifications?",
  "CodexNest сообщит, когда задача завершится или потребуется ваше решение.":
    "CodexNest will notify you when a task finishes or needs your decision.",
  "Не сейчас": "Not now",
  "Запрашиваем…": "Requesting…",
  "Разрешить уведомления": "Allow notifications",
  "Нет открытых сессий": "No open sessions",
  "Создайте сессию в проекте": "Create a session in a project",
  "Откройте список проектов и нажмите + рядом с нужным проектом.":
    "Open the project list and click + next to the project you need.",
  "Открыть проекты": "Open projects",
  "Путь скопирован": "Path copied",
  "Не удалось скопировать путь": "Failed to copy path",
  "Не удалось изменить порядок проектов": "Failed to reorder projects",
  "Не удалось удалить проект": "Failed to remove project",
  "Не удалось создать сессию": "Failed to create session",
  "Не удалось создать ответвление сессии": "Failed to fork session",
  "Не удалось начать создание ответвления": "Failed to start creating the fork",
  "Не удалось загрузить создаваемое ответвление": "Failed to load the pending fork",
  "Не удалось загрузить исходную историю": "Failed to load the source history",
  "Новое ответвление": "New fork",
  "Как перенести контекст?": "How should context be transferred?",
  "Выберите баланс между скоростью и буквальной точностью истории.":
    "Choose the balance between speed and a literal copy of the history.",
  "Создать ветку": "Create a fork",
  "Выберите, сколько истории взять с собой.": "Choose how much history to bring with you.",
  "Точка ответвления": "Fork point",
  "Исходный контекст · {{size}}": "Source context · {{size}}",
  "Считаем…": "Calculating…",
  "размер неизвестен": "size unknown",
  "Способ переноса контекста": "Context transfer method",
  Сжатая: "Compressed",
  Точная: "Exact",
  Компактная: "Compact",
  "Полная история": "Full history",
  Быстрее: "Faster",
  Рекомендуем: "Recommended",
  "Переносит смысл и решения в компактном контексте без выдуманных сообщений.":
    "Transfers meaning and decisions in compact context without invented messages.",
  "Копирует доступную историю буквально. Для большой сессии это займёт больше времени и места.":
    "Copies the available history literally. A large session will take more time and space.",
  "Сохраняет сжатый контекст и недавний ход работы. Лучше для больших сессий.":
    "Keeps the compacted context and recent work. Better for large sessions.",
  "Создаёт свежее сжатие и переносит только компактный контекст. Лучше для больших сессий.":
    "Creates a fresh compaction and transfers only compact context. Better for large sessions.",
  "Копирует всё до выбранного ответа. Выбирайте, если важны дословные детали.":
    "Copies everything through the selected answer. Choose this when exact details matter.",
  "Не удалось рассчитать сжатую ветку. Точная копия всё ещё доступна.":
    "The compressed fork could not be estimated. An exact copy is still available.",
  "Этот способ сейчас недоступен": "This method is currently unavailable",
  "Сжатый контекст для этой точки недоступен. Выберите полную историю.":
    "Compact context is unavailable at this point. Choose full history.",
  Объём: "Size",
  Время: "Time",
  неизвестно: "unknown",
  "рассчитается при создании": "calculated during creation",
  Б: "B",
  КБ: "KB",
  МБ: "MB",
  ГБ: "GB",
  "{{count}} с": "{{count}} sec",
  "Создать ответвление": "Create fork",
  "Готовим ответвление. Можно писать дальше — сообщения встанут в очередь.":
    "Preparing the fork. You can keep writing—messages will be queued.",
  "Сверяем перенесённый контекст и готовим ветку к работе.":
    "Reconciling transferred context and preparing the fork for work.",
  "Не удалось создать ответвление.": "The fork could not be created.",
  "Ответвление готово. Открываем…": "The fork is ready. Opening…",
  "Готовим ветку": "Preparing fork",
  "Сверяем контекст": "Reconciling context",
  "Ветка готова": "Fork ready",
  "Создание остановлено": "Creation stopped",
  "Копируем историю": "Copying history",
  "Сжимаем контекст": "Compacting context",
  "Собираем ветку": "Building fork",
  "Переносим полную историю до выбранного ответа.":
    "Copying the full history through the selected answer.",
  "Создаём свежее сжатие во временной копии. Исходная сессия не меняется.":
    "Creating a fresh compaction in a temporary copy. The source session stays unchanged.",
  "Переносим только новый компактный контекст в чистую ветку.":
    "Transferring only the new compact context into a clean fork.",
  "Проверяем точку ответвления. Можно писать дальше — сообщения встанут в очередь.":
    "Checking the fork point. You can keep writing—messages will be queued.",
  "Исходная ветка": "Source branch",
  "Контекст перенесён в сжатом виде из исходной ветки.":
    "Context was transferred from the source branch in compressed form.",
  "Ответвление от {{title}}": "Forked from {{title}}",
  "Ответвление · Родитель недоступен": "Fork · Parent unavailable",
  "Показать ответвления: {{count}}": "Show forks: {{count}}",
  Ответвления: "Forks",
  "Состояние: {{state}}": "Status: {{state}}",
  "Не удалось создать Team-сессию": "Failed to create Team session",
  "Включить браузер": "Enable browser",
  "Выключить браузер": "Disable browser",
  "Браузер включён": "Browser enabled",
  "Браузер подключён": "Browser connected",
  "Изменяем доступ браузера…": "Changing browser access…",
  "Дождитесь завершения текущего хода, чтобы изменить доступ браузера":
    "Wait for the current turn to finish before changing browser access",
  "Не удалось изменить доступ браузера": "Failed to change browser access",
  "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди":
    "A project cannot be removed while its sessions are running, awaiting a decision, or have queued messages",
  Архив: "Archive",
  "Состояние сервера: {{state}}": "Server status: {{state}}",
  "Доступно обновление CodexNest": "CodexNest update available",
  Настройки: "Settings",
  "Добавить проект": "Add project",
  Проекты: "Projects",
  Активные: "Active",
  "Режим списка сессий": "Session list mode",
  "Нет активных сессий": "No active sessions",
  Задачи: "Tasks",
  "Без проекта": "No project",
  "Перетащить проект {{project}}": "Drag project {{project}}",
  "Действия с проектом {{project}}": "Actions for project {{project}}",
  "Копировать путь": "Copy path",
  "Переместить выше": "Move up",
  "Переместить ниже": "Move down",
  "Удалить проект": "Remove project",
  "Удалить проект «{{project}}» из Codex Nest? Проект и его сессии исчезнут из приложения, но папка и история сохранятся.":
    "Remove “{{project}}” from Codex Nest? The project and its sessions will disappear from the app, but the folder and history will be preserved.",
  "Создать новую сессию в проекте {{project}}": "Create a new session in {{project}}",
  "Создать новую Team-сессию": "Create a new Team session",
  "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.":
    "This session predates managed Team tools. Create a new Team session.",
  "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.":
    "Team mode cannot be disabled while subagents are running or their results are still pending. Ask the root agent to finish or cancel them.",
  "Показать меньше": "Show less",
  "Показать ещё {{count}}": "Show {{count}} more",
  "Пока нет задач": "No tasks yet",
  "Повторить лимиты": "Retry limits",
  "Лимиты Codex": "Codex limits",
  "Лимиты недоступны": "Limits unavailable",
  Лимит: "Limit",
  "{{count}} д": "{{count}}d",
  "{{count}} ч": "{{count}}h",
  "{{count}} мин": "{{count}}m",
  "Обновляем лимиты Codex": "Refreshing Codex limits",
  "Повторить обновление лимитов Codex": "Retry refreshing Codex limits",
  "Показать лимиты Codex": "Show Codex limits",
  "Обновить лимиты Codex: {{text}}": "Refresh Codex limits: {{text}}",
  "Последнее обновление: {{time}}": "Last updated: {{time}}",
  "Не удалось обновить лимиты Codex": "Could not refresh Codex limits",
  Подключено: "Connected",
  "Подключение…": "Connecting…",
  "Нет связи": "Offline",
  "Codex ждёт решения": "Codex needs your decision",
  "Задача завершена": "Task completed",
  "Задача завершилась с ошибкой": "Task failed",
  "Откройте CodexNest для подробностей": "Open CodexNest for details",
  "Задача Codex": "Codex task",
  "Введите bearer token": "Enter the bearer token",
  "Не удалось сохранить подключение": "Failed to save the connection",
  "Подключение к CodexNest": "Connect to CodexNest",
  "Укажите адрес домашнего сервера и bearer token.":
    "Enter the address of your home server and its bearer token.",
  "Адрес сервера": "Server address",
  "HTTP не шифрует token и содержимое сессий. Используйте только доверенную LAN.":
    "HTTP does not encrypt the token or session content. Use it only on a trusted LAN.",
  "Проверяем…": "Checking…",
  Подключиться: "Connect",
  "Разрешены только адреса http:// и https://": "Only http:// and https:// addresses are allowed",
  "Не удалось подключиться к серверу": "Failed to connect to the server",
  "Связь с сервером потеряна": "Connection to the server was lost",
  "Запрашивать разрешение": "Ask for permission",
  "Codex работает в проекте и спрашивает вас перед расширением доступа.":
    "Codex works within the project and asks before expanding access.",
  "Подтверждать автоматически": "Approve automatically",
  "Потенциально опасные действия проверяет отдельный reviewer Codex.":
    "A separate Codex reviewer checks potentially dangerous actions.",
  "Полный доступ": "Full access",
  "Claude запрашивает подтверждение команд и изменений файлов.":
    "Claude asks before running commands and changing files.",
  "Claude выполняет команды и изменяет файлы без запросов разрешения.":
    "Claude runs commands and changes files without permission prompts.",
  "Режим сохраняется для новых сессий и применяется к запущенным агентам Claude.":
    "The mode is saved for new sessions and applied to running Claude agents.",
  "Неограниченный доступ к интернету и любым файлам пользователя на сервере.":
    "Unrestricted access to the internet and any user files on the server.",
  "Не удалось загрузить настройки": "Failed to load settings",
  "Конфигурация Codex изменилась. Проверьте значение и сохраните ещё раз.":
    "The Codex configuration changed. Check the value and save again.",
  "Не удалось сохранить настройки": "Failed to save settings",
  "Не удалось сохранить настройки новых задач": "Failed to save new task settings",
  "Приложение, Codex и сервер": "Application, Codex, and server",
  "Разделы настроек": "Settings sections",
  Приложение: "Application",
  Подключение: "Connection",
  Обслуживание: "Maintenance",
  Скиллы: "Skills",
  "Установленные возможности Codex для выбранного проекта.":
    "Installed Codex capabilities for the selected project.",
  "Каталог и переключатели ниже относятся к выбранному проекту.":
    "The catalog and switches below apply to the selected project.",
  "Проект для скиллов": "Project for skills",
  "Обновить список скиллов": "Refresh skills",
  "Добавьте проект, чтобы посмотреть доступные для него скиллы.":
    "Add a project to view its available skills.",
  "Поиск скиллов": "Search skills",
  "Поиск по названию и описанию": "Search by name and description",
  "Загружаем скиллы…": "Loading skills…",
  "Не удалось загрузить скиллы": "Failed to load skills",
  "Не удалось изменить состояние скилла": "Failed to update skill state",
  "Ошибки обнаружения: {{count}}": "Discovery errors: {{count}}",
  "Скиллы не найдены": "No skills found",
  "Ничего не найдено": "No results",
  "Описание не указано": "No description provided",
  "Выключить скилл {{name}}": "Disable skill {{name}}",
  "Включить скилл {{name}}": "Enable skill {{name}}",
  Проектный: "Repository",
  Пользовательский: "User",
  Административный: "Admin",
  Системный: "System",
  "Доступные скиллы": "Available skills",
  "Нет подходящих скиллов": "No matching skills",
  "Новые задачи": "New tasks",
  "Fast mode по умолчанию": "Fast mode by default",
  "Ускоряет ответы Codex и увеличивает расход лимитов.":
    "Speeds up Codex responses and increases quota usage.",
  "Fast mode недоступен для этой модели.": "Fast mode is unavailable for this model.",
  "Эти значения применяются к новым сессиям и задачам на всех подключённых устройствах.":
    "These values apply to new sessions and tasks on every connected device.",
  "Модель, которая будет выбрана для новых сессий.": "Model selected for new sessions.",
  "Модель для автоматических названий сессий.": "Model used for automatic session titles.",
  "Стиль ответов для новых задач.": "Response style for new tasks.",
  "По умолчанию": "Default",
  Дружелюбная: "Friendly",
  Прагматичная: "Pragmatic",
  "Без personality": "No personality",
  "Сохраняем…": "Saving…",
  "Сохранить настройки новых задач": "Save new task settings",
  "Разрешения Codex": "Codex permissions",
  "Выбранный режим применяется ко всем задачам со следующего хода.":
    "The selected mode applies to all tasks from their next turn.",
  "Загружаем конфигурацию…": "Loading configuration…",
  "Режим разрешений": "Permission mode",
  "Обнаружена нестандартная конфигурация. Выберите один из режимов и сохраните его.":
    "A custom configuration was detected. Select and save one of the modes.",
  "Настройка переопределена управляемой политикой Codex.":
    "This setting is overridden by a managed Codex policy.",
  "Полный доступ снимает ограничения на файлы и сеть. Используйте его только на доверенном сервере.":
    "Full access removes file and network restrictions. Use it only on a trusted server.",
  Сохранить: "Save",
  "Уведомления браузера": "Browser notifications",
  "События приходят напрямую с вашего сервера, без Google и внешнего push.":
    "Events come directly from your server without Google or external push services.",
  "Уведомления включены. Они приходят, пока вкладка открыта или свёрнута.":
    "Notifications are enabled. They arrive while the tab is open or minimized.",
  "Уведомления заблокированы. Разрешите их в настройках сайта в браузере.":
    "Notifications are blocked. Allow them in the browser's site settings.",
  "Этот браузер не предоставляет системные уведомления для текущего подключения. Некоторые браузеры требуют открыть CodexNest по HTTPS.":
    "This browser does not provide system notifications for the current connection. Some browsers require CodexNest to be opened over HTTPS.",
  Интерфейс: "Interface",
  "Язык интерфейса синхронизируется через сервер; остальные настройки применяются только на этом устройстве.":
    "The interface language is synchronized through the server; other settings apply only to this device.",
  "Язык интерфейса": "Interface language",
  "Синхронизируется между подключёнными устройствами.": "Synchronized across connected devices.",
  "Не удалось сохранить язык интерфейса": "Failed to save the interface language",
  Тема: "Theme",
  "Светлая, тёмная или системная цветовая схема.": "Light, dark, or system color scheme.",
  "Системная тема": "System theme",
  "Светлая тема": "Light theme",
  "Тёмная тема": "Dark theme",
  "Боковая панель": "Sidebar",
  "Ширина боковой панели": "Sidebar width",
  "Расположение списка проектов и задач.": "Placement of the project and task list.",
  Слева: "Left",
  Справа: "Right",
  "Порядок проектов": "Project order",
  "Как проекты расположены в боковой панели.": "How projects are ordered in the sidebar.",
  "Сверху вниз": "Top to bottom",
  "Снизу вверх": "Bottom to top",
  Сервер: "Server",
  "Подключение к CodexNest на этом устройстве.": "CodexNest connection on this device.",
  "Сменить сервер": "Switch server",
  "Настройки применены на сервере для всех клиентов.":
    "Settings were applied on the server for all clients.",
  "Не удалось сохранить настройки распознавания": "Failed to save speech recognition settings",
  "Распознавание речи": "Speech recognition",
  "Эти настройки общие для всех клиентов и сохраняются на сервере.":
    "These settings are shared by all clients and stored on the server.",
  "Не удалось получить настройки распознавания: {{error}}":
    "Failed to load speech recognition settings: {{error}}",
  "Загружаем настройки…": "Loading settings…",
  Провайдер: "Provider",
  "Где обрабатывается записанное аудио.": "Where recorded audio is processed.",
  "Провайдер распознавания речи": "Speech recognition provider",
  "Выберите провайдера": "Select a provider",
  "Локальная модель": "Local model",
  "URL локального STT": "Local STT URL",
  "HTTP-адрес сервиса распознавания на вашем сервере.":
    "HTTP endpoint of the transcription service on your server.",
  "Расставлять пунктуацию и исправлять очевидные ошибки через Codex":
    "Add punctuation and correct obvious errors with Codex",
  "Модель улучшения": "Refinement model",
  "Модель улучшения расшифровки": "Transcript refinement model",
  "Аудио остаётся на сервере. При включённом улучшении в Codex отправляется только распознанный текст.":
    "Audio stays on the server. When refinement is enabled, only the recognized text is sent to Codex.",
  "Модель OpenAI": "OpenAI model",
  "Модель распознавания OpenAI": "OpenAI transcription model",
  "gpt-4o-transcribe — точнее": "gpt-4o-transcribe — more accurate",
  "gpt-4o-mini-transcribe — дешевле": "gpt-4o-mini-transcribe — cheaper",
  "Ключ сохранён; оставьте пустым без изменений": "Key saved; leave empty to keep it unchanged",
  "Хранится на сервере и не возвращается в интерфейс.":
    "Stored on the server and never returned to the interface.",
  Скрыть: "Hide",
  Показать: "Show",
  "Ключ будет удалён": "The key will be removed",
  "API key настроен": "API key configured",
  "Код языка аудио, например ru или en.": "Audio language code, such as ru or en.",
  "Не удалять": "Keep key",
  "Удалить ключ": "Delete key",
  "Ввод API key доступен только через HTTPS или локальное подключение.":
    "API key entry is available only over HTTPS or a local connection.",
  "Аудио отправляется в OpenAI API и оплачивается отдельно от подписки ChatGPT или Codex.":
    "Audio is sent to the OpenAI API and billed separately from a ChatGPT or Codex subscription.",
  Язык: "Language",
  "Язык распознавания": "Recognition language",
  "Настройте URL локального STT или OpenAI API key, чтобы включить микрофон.":
    "Configure a local STT URL or OpenAI API key to enable the microphone.",
  "Выбранный провайдер настроен не полностью. Исправьте параметры и сохраните форму.":
    "The selected provider is not fully configured. Correct the settings and save the form.",
  "Сохранить распознавание": "Save speech recognition",
  "Определяем…": "Detecting…",
  "Только в Android": "Android only",
  "Не удалось получить состояние CodexNest": "Failed to get CodexNest status",
  "Не удалось определить": "Could not determine",
  "Не удалось проверить обновления CodexNest": "Failed to check for CodexNest updates",
  " до версии {{version}}": " to version {{version}}",
  "Обновить CodexNest{{target}}? Интерфейс ненадолго переподключится.":
    "Update CodexNest{{target}}? The interface will briefly reconnect.",
  "Не удалось запустить обновление CodexNest": "Failed to start the CodexNest update",
  "Не удалось открыть загрузку APK": "Failed to open the APK download",
  "Аварийное восстановление": "Emergency recovery",
  "Используйте только если обычное обновление или работа сессий зависли. Эти действия обходят безопасное ожидание активных задач.":
    "Use this only when a normal update or session operation is stuck. These actions bypass the safe wait for active tasks.",
  "Активных ответов: {{count}}. Жёсткий перезапуск может их прервать.":
    "Active responses: {{count}}. A force restart may interrupt them.",
  "Жёсткий перезапуск может прервать незавершённые операции.":
    "A force restart may interrupt unfinished operations.",
  "Жёстко перезапустить CodexNest? Текущее обновление будет остановлено, а незавершённые операции интерфейса могут быть прерваны. Codex daemon останется запущен.":
    "Force restart CodexNest? The current update will be stopped and unfinished interface operations may be interrupted. The Codex daemon will remain running.",
  "Жёстко перезапустить CodexNest? Текущее обновление будет остановлено, а незавершённые операции интерфейса могут быть прерваны. Сессии Codex продолжат работу.":
    "Force restart CodexNest? The current update will be stopped and unfinished interface operations may be interrupted. Codex sessions will keep running.",
  "Жёстко перезапустить Codex daemon? Все активные ответы Codex будут прерваны.":
    "Force restart the Codex daemon? All active Codex responses will be interrupted.",
  "Жёстко перезапустить CodexNest": "Force restart CodexNest",
  "Жёстко перезапустить Codex": "Force restart Codex",
  "Перезапускаем CodexNest…": "Restarting CodexNest…",
  "Перезапускаем Codex…": "Restarting Codex…",
  "Codex daemon аварийно перезапущен.": "The Codex daemon was force restarted.",
  "Не удалось запустить аварийный перезапуск CodexNest":
    "Failed to start the CodexNest force restart",
  "Не удалось аварийно перезапустить Codex daemon": "Failed to force restart the Codex daemon",
  "CodexNest не восстановил соединение после перезапуска.":
    "CodexNest did not reconnect after the restart.",
  "Обновление CodexNest": "CodexNest update",
  Обновление: "Update",
  "Загрузки и ссылки": "Downloads and links",
  "Сервер, APK и расширение для Chrome обновляются из одной проверенной CI-сборки с автоматическим откатом.":
    "The server, APK, and Chrome extension update from the same verified CI build with automatic rollback.",
  "Сервер, веб-интерфейс и APK выпускаются из одной проверенной CI-сборки. При неудачном обновлении сервер автоматически возвращается к предыдущей версии.":
    "The server, web interface, and APK are released from the same verified CI build. If a server update fails, the server automatically returns to the previous version.",
  "Получаем версию CodexNest…": "Loading CodexNest version…",
  "Технические детали": "Technical details",
  "Повторить загрузку технических деталей": "Retry loading technical details",
  Рассуждение: "Reasoning",
  "Готово за {{duration}}": "Completed in {{duration}}",
  "Ошибка через {{duration}}": "Failed after {{duration}}",
  Прервано: "Interrupted",
  "Прервано через {{duration}}": "Interrupted after {{duration}}",
  "Установлено на сервере": "Installed on server",
  "Актуальная версия в GitHub": "Latest version on GitHub",
  "Не проверялась": "Not checked",
  "APK на этом устройстве": "APK on this device",
  Состояние: "Status",
  Результат: "Result",
  "Не удалось сохранить черновики перед загрузкой нового интерфейса. Сохраните ввод и обновите страницу.":
    "Drafts could not be saved before loading the new interface. Save your input and reload the page.",
  "Обновления доступны только для управляемой установки ClaudeNest.":
    "Updates require a managed ClaudeNest installation.",
  "Обновления доступны только для установки через install.sh.":
    "Updates are available only for installations made with install.sh.",
  "Открыть GitHub": "Open GitHub",
  "Не удалось открыть GitHub": "Failed to open GitHub",
  "Скачать свежий APK": "Download latest APK",
  "Скачать расширение для Chrome": "Download Chrome extension",
  "Не удалось открыть загрузку расширения для Chrome":
    "Failed to open the Chrome extension download",
  "Проверить обновления": "Check for updates",
  "Обновляем…": "Updating…",
  "Обновить CodexNest": "Update CodexNest",
  Готово: "Ready",
  Проверка: "Checking",
  Подготовка: "Preparing",
  Сборка: "Building",
  "Переключение версии": "Switching version",
  Перезапуск: "Restarting",
  Обновлено: "Updated",
  "Выполнен откат": "Rolled back",
  Ошибка: "Error",
  "Не удалось загрузить состояние Codex": "Failed to load Codex status",
  "Прокси проверен и применён. Codex daemon готов к работе.":
    "The proxy was verified and applied. The Codex daemon is ready.",
  "Проверка Codex и соединения через прокси завершена.":
    "Codex and its proxy connection were checked.",
  "Обновить Codex и перезапустить daemon?": "Update Codex and restart the daemon?",
  "Codex обновлён, проверен через прокси и перезапущен.":
    "Codex was updated, verified through the proxy, and restarted.",
  "Перезапустить Codex daemon?": "Restart the Codex daemon?",
  "Codex daemon перезапущен.": "The Codex daemon was restarted.",
  "Операция Codex завершилась ошибкой": "The Codex operation failed",
  "Версия и состояние Codex daemon на сервере.": "Codex daemon version and status on the server.",
  "Установленная версия Codex CLI": "Installed Codex CLI version",
  "Актуальная версия Codex CLI": "Latest Codex CLI version",
  "Дождитесь завершения активных ответов: {{count}}.":
    "Wait for active responses to finish: {{count}}.",
  "Дождитесь завершения активных ответов перед обновлением CodexNest.":
    "Wait for active responses to finish before updating CodexNest.",
  "Проверить Codex CLI": "Check Codex CLI",
  "Обновить Codex CLI": "Update Codex CLI",
  "Перезапускаем…": "Restarting…",
  Перезапустить: "Restart",
  Прокси: "Proxy",
  "Внутренние запросы Codex идут через fail-closed прокси; команды агента — напрямую.":
    "Internal Codex requests use the fail-closed proxy; agent commands connect directly.",
  "Получаем состояние прокси…": "Loading proxy status…",
  "Текущий прокси": "Current proxy",
  "WebSocket ChatGPT/OpenAI доступен через прокси.":
    "The ChatGPT/OpenAI WebSocket is reachable through the proxy.",
  "Ввод прокси с паролем доступен только через HTTPS или локальное подключение.":
    "A password-protected proxy can be entered only over HTTPS or a local connection.",
  "Новый HTTP/HTTPS-прокси": "New HTTP/HTTPS proxy",
  "Будет проверен до перезапуска Codex daemon.":
    "It will be verified before the Codex daemon restarts.",
  "Форматы: host:port, host:port:user:password, user:password@host:port или полный URL.":
    "Formats: host:port, host:port:user:password, user:password@host:port, or a full URL.",
  "Проверяем и применяем…": "Checking and applying…",
  "Проверить и применить": "Check and apply",
  "Не настроен": "Not configured",
  " · пароль сохранён": " · password saved",
  Работает: "Running",
  "Не поддерживается": "Unsupported",
  Недоступен: "Unavailable",
  "Открыть список задач": "Open task list",
  "Показать сведения": "Show details",
  "Принудительно обновить сессию": "Force refresh session",
  "Обновляем состояние сессии": "Refreshing session state",
  "Не удалось обновить сессию": "Failed to refresh session",
  "Не удалось создать задачу": "Failed to create task",
  "Новая задача": "New task",
  "Выберите проект": "Select a project",
  "Что поручим Codex?": "What should Codex do?",
  "Опишите задачу — работа продолжится на сервере, даже если закрыть приложение.":
    "Describe the task — work will continue on the server even if you close the app.",
  "Распознавание речи не настроено": "Speech recognition is not configured",
  "Закрыть сведения": "Close details",
  "Не удалось открыть папку": "Failed to open folder",
  "Не удалось создать папку": "Failed to create folder",
  "Не удалось добавить проект": "Failed to add project",
  "Рабочая папка на сервере": "Working folder on the server",
  Закрыть: "Close",
  "На уровень выше": "Up one level",
  "Путь к папке": "Folder path",
  "Предыдущее изображение": "Previous image",
  "Просмотр изображений": "Image viewer",
  "Домашняя папка": "Home folder",
  Загрузка: "Loading",
  "Новая папка": "New folder",
  "Показывать скрытые": "Show hidden folders",
  "Название новой папки": "New folder name",
  "Создаём…": "Creating…",
  Создать: "Create",
  Отмена: "Cancel",
  Папки: "Folders",
  "Получаем папки с сервера…": "Loading folders from the server…",
  "Скрытые папки не показаны": "Hidden folders are not shown",
  "В этой папке нет других папок": "There are no other folders here",
  "Добавляем…": "Adding…",
  "Выбрать эту папку": "Select this folder",
  Домашняя: "Home",
  "Сведения о задаче": "Task details",
  Сведения: "Details",
  Сессия: "Session",
  "Разделы сведений": "Details sections",
  Обзор: "Overview",
  Артефакты: "Artifacts",
  "Артефакты, {{count}}": "Artifacts, {{count}}",
  "Загружаем артефакты…": "Loading artifacts…",
  "Не удалось загрузить артефакты.": "Could not load artifacts.",
  "В этой сессии пока нет артефактов": "There are no artifacts in this session yet",
  "Файлы появятся здесь, когда Codex приложит их к ответу.":
    "Files will appear here when Codex attaches them to a response.",
  "Артефакты недоступны для этой сессии": "Artifacts are unavailable for this session",
  "Явные артефакты доступны в новых сессиях.": "Explicit artifacts are available in new sessions.",
  Статус: "Status",
  Проект: "Project",
  Создана: "Created",
  Обновлена: "Updated",
  "Рабочая папка": "Working folder",
  Открепить: "Unpin",
  Закрепить: "Pin",
  "Новая сессия": "New session",
  "Закрепить сессию «{{title}}»": "Pin session “{{title}}”",
  "Открепить сессию «{{title}}»": "Unpin session “{{title}}”",
  "Сессия закреплена": "Session pinned",
  "Показать закрепленные ({{count}})": "Show pinned sessions ({{count}})",
  "Свернуть закрепленные ({{count}})": "Collapse pinned sessions ({{count}})",
  "Действия с сессией «{{title}}»": "Actions for session “{{title}}”",
  "Не удалось изменить закрепление сессии": "Failed to change session pinning",
  "Закончить сессию": "Finish session",
  "Подтвердить завершение": "Confirm finish",
  "Вернуть из архива": "Restore from archive",
  Архивировать: "Archive",
  "Сведения о новой задаче": "New task details",
  "Не выбран": "Not selected",
  "Задача будет создана после отправки первого сообщения.":
    "The task will be created after the first message is sent.",
  "Загрузка…": "Loading…",
  Недоступно: "Unavailable",
  "Не Git-репозиторий": "Not a Git repository",
  "Нет изменений": "No changes",
  "{{count}} file": "{{count}} file",
  "{{count}} files": "{{count}} files",
  "{{count}} файл": "{{count}} file",
  "{{count}} файла": "{{count}} files",
  "{{count}} файлов": "{{count}} files",
  "Нужно решение": "Needs attention",
  Выполняется: "Running",
  Завершена: "Completed",
  Прервана: "Interrupted",
  Готова: "Ready",
  Недоступна: "Unavailable",
  Модель: "Model",
  "Настройки модели": "Model settings",
  "Модель и уровень рассуждений": "Model and reasoning effort",
  "Уровень рассуждений": "Reasoning effort",
  "Выключить режим планирования": "Disable Plan mode",
  "Включить режим планирования": "Enable Plan mode",
  "Выключить командный режим": "Disable Team mode",
  "Включить командный режим": "Enable Team mode",
  "Свернуть субагентов": "Collapse subagents",
  "Показать субагентов": "Show subagents",
  "Субагенты · {{count}}": "Subagents · {{count}}",
  "{{count}} агент работает": "{{count}} agent running",
  "{{count}} агента работают": "{{count}} agents running",
  "{{count}} агентов работают": "{{count}} agents running",
  "В очереди: {{count}}": "Queued: {{count}}",
  "Требуется внимание: {{count}}": "Needs attention: {{count}}",
  "Субагент управляется родительской сессией. Здесь доступен только просмотр.":
    "This subagent is managed by its parent session. This view is read-only.",
  "Открыть родительскую сессию": "Open parent session",
  "Запуск субагента": "Starting subagent",
  "Запущен субагент": "Subagent started",
  "Не удалось запустить субагента": "Failed to start subagent",
  Субагент: "Subagent",
  Запуск: "Starting",
  Запущен: "Started",
  Ожидает: "Waiting",
  "Запущен {{count}} субагент": "{{count}} subagent started",
  "Запущены {{count}} субагента": "{{count}} subagents started",
  "Запущены {{count}} субагентов": "{{count}} subagents started",
  "Запуск субагентов: {{count}}": "Starting subagents: {{count}}",
  "Запуски субагентов: {{count}}": "Subagent launches: {{count}}",
  "{{count}} работает": "{{count}} running",
  "{{count}} работают": "{{count}} running",
  "{{count}} готов": "{{count}} ready",
  "{{count}} готовы": "{{count}} ready",
  "Статус субагента: {{status}}": "Subagent status: {{status}}",
  "Открыть диалог субагента: {{title}}": "Open subagent conversation: {{title}}",
  "Получен результат субагента": "Subagent result received",
  "Получены результаты субагентов": "Subagent results received",
  "Статус результата: {{status}}": "Result status: {{status}}",
  "Проверки результата": "Result checks",
  Успешно: "Successful",
  Частично: "Partial",
  Заблокировано: "Blocked",
  Пройдена: "Passed",
  "Не запускалась": "Not run",
  Причина: "Reason",
  Изменения: "Changes",
  "Изменённые файлы": "Changed files",
  "Показано {{shown}} из {{total}}": "Showing {{shown}} of {{total}}",
  "Истекло время": "Timed out",
  "Исчерпан бюджет токенов": "Token budget exhausted",
  "Изменения интегрированы": "Changes integrated",
  "Изолированная рабочая папка готова": "Isolated workspace ready",
  "Интегрируем изменения": "Integrating changes",
  "Конфликт интеграции": "Integration conflict",
  "Интеграция не требуется": "No integration needed",
  "Интеграция требует восстановления": "Integration recovery required",
  "Управление целью": "Manage goal",
  Пауза: "Pause",
  Продолжить: "Resume",
  Очистить: "Clear",
  "Выключить режим цели": "Disable Goal mode",
  "Включить режим цели": "Enable Goal mode",
  "Цель активна": "Goal active",
  "Цель на паузе": "Goal paused",
  "Цель заблокирована": "Goal blocked",
  "Достигнут лимит использования": "Usage limit reached",
  "Достигнут бюджет цели": "Goal budget reached",
  "Цель выполнена": "Goal complete",
  "{{count}}м {{seconds}}с": "{{count}}m {{seconds}}s",
  "{{count}}с": "{{count}}s",
  "{{count}} токен": "{{count}} token",
  "{{count}} токена": "{{count}} tokens",
  "{{count}} токенов": "{{count}} tokens",
  "Требуется внимание": "Attention required",
  "Прокрутить к последнему сообщению": "Scroll to latest message",
  "Запрос уже закрыт": "The request is already closed",
  "Разрешить команду?": "Allow this command?",
  "Команда не указана": "No command provided",
  "Сетевой host: {{host}}": "Network host: {{host}}",
  "Отдельные изменения policy": "Separate policy changes",
  "Обычное подтверждение эти правила не применяет.":
    "A regular approval does not apply these rules.",
  "Разрешить изменения файлов?": "Allow file changes?",
  "Запрошенный корень: {{root}}": "Requested root: {{root}}",
  "Несовместимое действие": "Unsupported action",
  "Разрешить один раз": "Allow once",
  "На сессию": "For session",
  Отказать: "Decline",
  "Отменить turn": "Cancel turn",
  "Дополнительные разрешения": "Additional permissions",
  Сеть: "Network",
  Чтение: "Read",
  Запись: "Write",
  "Выдать на turn": "Grant for turn",
  "Codex просит уточнение": "Codex needs clarification",
  "Вопрос {{current}} из {{total}}": "Question {{current}} of {{total}}",
  "Навигация по вопросам": "Question navigation",
  "Вопрос {{current}} из {{total}}: {{header}}{{answered}}":
    "Question {{current}} of {{total}}: {{header}}{{answered}}",
  ", есть ответ": ", answered",
  ", без ответа": ", unanswered",
  "Свой ответ": "Your answer",
  "Очистить ответ": "Clear answer",
  "Отправить ответы": "Submit answers",
  Назад: "Back",
  Далее: "Next",
  "Не удалось сохранить черновик. Повторим при следующем изменении.":
    "Could not save the draft. We’ll retry on the next change.",
  "Сессия недоступна. Сообщение сохранено.": "The session is unavailable. Your message is saved.",
  "Проверяем, было ли сообщение отправлено.": "Checking whether your message was delivered.",
  "Ожидаем восстановления связи. Сообщение сохранено.":
    "Waiting to reconnect. Your message is saved.",
  "Не удалось отправить сообщение. Оно сохранено.": "Could not send your message. It is saved.",
  "Не удалось загрузить историю сессии": "Could not load the session history",
  "Не удалось загрузить историю сессии. Сохранённые сообщения доступны ниже.":
    "Could not load the session history. Saved messages are available below.",
  "Повторить загрузку истории": "Retry loading history",
  "Скопировать сообщение": "Copy message",
  Отправлено: "Sent",
  "Сохранено на устройстве": "Saved on this device",
  "Сервер временно недоступен — повторим отправку": "Server temporarily unavailable — we’ll retry",
  "Codex временно недоступен. Повторим отправку. Сообщение сохранено.":
    "Codex is temporarily unavailable. We’ll retry. Your message is saved.",
  "Не удалось сохранить черновик на устройстве": "Could not save the draft on this device",
  "Не отправлено": "Not sent",
  "Нет связи — повторим отправку": "Offline — we’ll retry sending",
  "Повторить отправку": "Retry sending",
  "Автовыбор через {{seconds}} сек.": "Automatic selection in {{seconds}} sec.",
  "Время автовыбора истекло": "Automatic selection time expired",
  "Действие во внешнем сервисе": "Action in an external service",
  "Открыть в браузере": "Open in browser",
  "Открыть изображение {{name}}": "Open image {{name}}",
  "Открыть изображение {{number}}": "Open image {{number}}",
  "Загружаем изображение…": "Loading image…",
  "Не удалось загрузить изображение. Повторить": "Could not load image. Retry",
  Отменить: "Cancel",
  "Форма инструмента": "Tool form",
  Отправить: "Submit",
  Выберите: "Select",
  "Заполните обязательное поле «{{field}}»": "Complete the required field “{{field}}”",
  "Выберите больше значений в поле «{{field}}»": "Select more values in “{{field}}”",
  "Выберите меньше значений в поле «{{field}}»": "Select fewer values in “{{field}}”",
  "Codex app-server недоступен": "Codex app-server is unavailable",
  "Без названия": "Untitled",
  "Инструмент завершился с ошибкой": "Tool finished with an error",
  "MCP-инструмент": "MCP tool",
  Инструмент: "Tool",
  "Активность Codex": "Codex activity",
  "Первый ход начат, но цель осталась на паузе. Продолжите её вручную.":
    "The first turn started, but the goal remained paused. Resume it manually.",
  "Эта версия Codex запросила действие, которое CodexNest пока не поддерживает.":
    "This Codex version requested an action that CodexNest does not support yet.",
  "Codex работает": "Codex is working",
  "Ждёт вашего ответа": "Waiting for your answer",
  Аннотация: "Annotate",
  "Аннотация {{number}}": "Annotation {{number}}",
  Аннотации: "Annotations",
  "Перейти к аннотации {{number}}": "Go to annotation {{number}}",
  "Удалить аннотацию {{number}}": "Delete annotation {{number}}",
  "Исходная цитата не найдена в загруженной истории.":
    "The original quote was not found in the loaded history.",
  "В очереди": "Queued",
  Вложения: "Attachments",
  "Выполнен поиск": "Search completed",
  "Выполнена команда": "Command executed",
  Выполнено: "Completed",
  "Выполнены действия": "Actions completed",
  "Выполнены команды": "Commands executed",
  "Да, реализуй этот план": "Yes, implement this plan",
  "Запускаем выполнение плана…": "Starting plan implementation…",
  "Отказаться от плана": "Dismiss plan",
  "Отказываемся от плана…": "Dismissing plan…",
  "Не удалось отказаться от плана": "Failed to dismiss the plan",
  "Состояние сессии изменилось. Обновите сессию и повторите отказ от плана.":
    "The session changed. Refresh it and try dismissing the plan again.",
  "Да, реализуй этот план в режиме цели": "Yes, implement this plan in goal mode",
  "Да, реализуй этот план в режиме оркестратора": "Yes, implement this plan in orchestrator mode",
  "План ещё не обновлён после уточнений":
    "The plan has not yet been updated after your clarifications",
  "План не завершён": "The plan is incomplete",
  "Сначала ответьте на вопросы агента": "Answer the agent's questions first",
  "Сначала обработайте запросы, требующие внимания": "Handle the pending requests first",
  "Действия с задачей": "Task actions",
  "Для доступа к микрофону откройте CodexNest по HTTPS":
    "Open CodexNest over HTTPS to access the microphone",
  "Добавить в очередь": "Add to queue",
  "Добавляется…": "Adding…",
  "Добавить изображения": "Add images",
  "Добавить файлы": "Add files",
  "Загружаем старые сообщения": "Loading older messages",
  Задача: "Task",
  "Задача не найдена": "Task not found",
  "Заканчиваем…": "Finishing…",
  "Заканчиваем сессию «{{title}}»": "Finishing session “{{title}}”",
  Закончить: "Finish",
  "Закончить сессию «{{title}}»": "Finish session “{{title}}”",
  "Запись {{time}}": "Recording {{time}}",
  "Запись не содержит аудио": "The recording contains no audio",
  "Запись с микрофона не поддерживается на этом устройстве":
    "Microphone recording is not supported on this device",
  "Запись слишком большая": "The recording is too large",
  "Запись на сервере · можно закрыть": "Saved on the server · safe to close",
  "На сервере · ожидание {{time}}": "On the server · waiting {{time}}",
  "На сервере · ожидание": "On the server · waiting",
  "Запрашиваем доступ к микрофону": "Requesting microphone access",
  "Запустить цель": "Start goal",
  "Запустить в режиме цели": "Run in goal mode",
  "Запустить в режиме оркестратора": "Run in orchestrator mode",
  "Изменены файлы": "Files changed",
  "Изменён {{path}}": "Changed {{path}}",
  "Изображение {{number}}": "Image {{number}}",
  "Изображение {{current}} из {{total}}": "Image {{current}} of {{total}}",
  Изображения: "Images",
  Таблица: "Table",
  Файлы: "Files",
  "Использованы инструменты": "Tools used",
  "Идёт распознавание в другой сессии": "A recording is being transcribed in another session",
  Комментарий: "Comment",
  "Комментарий к выделенному тексту": "Comment on selected text",
  "Блок скопирован": "Block copied",
  Копировать: "Copy",
  "Копировать блок": "Copy block",
  "Копировать сообщение": "Copy message",
  "Создать ответвление отсюда": "Fork from here",
  "Микрофон занят другим приложением": "The microphone is in use by another app",
  "Микрофон не найден": "Microphone not found",
  Название: "Name",
  "Направить текущую задачу": "Steer the current task",
  "Направить текущую задачу…": "Steer the current task…",
  "Начать запись": "Start recording",
  "Не выполнено": "Not completed",
  "Нажмите ещё раз, чтобы закончить сессию «{{title}}»":
    "Click again to finish session “{{title}}”",
  "Не удалось закончить сессию": "Failed to finish the session",
  "Не удалось записать аудио": "Failed to record audio",
  "Не удалось изменить настройки": "Failed to change settings",
  "Не удалось изменить сообщение в очереди": "Failed to update the queued message",
  "Не удалось изменить цель": "Failed to change the goal",
  "Не удалось начать запись с микрофона": "Failed to start microphone recording",
  "Не удалось начать реализацию плана": "Failed to start implementing the plan",
  "Не удалось начать реализацию плана в режиме цели":
    "Failed to start implementing the plan in goal mode",
  "Не удалось начать реализацию плана в режиме оркестратора":
    "Failed to start implementing the plan in orchestrator mode",
  "Не удалось отправить сообщение": "Failed to send the message",
  "Не удалось отправить сразу — сообщение осталось в очереди":
    "Could not send immediately — the message remains queued",
  "Это сообщение уже отправлено": "This message has already been sent",
  "Не удалось остановить задачу": "Failed to stop the task",
  "Не удалось отправить запись на сервер": "Failed to upload the recording",
  "Не удалось надежно сохранить запись на устройстве":
    "Failed to save the recording safely on this device",
  "Не удалось очистить цель": "Failed to clear the goal",
  "Не удалось прочитать выбранное изображение": "Failed to read the selected image",
  "Не удалось загрузить выбранный файл": "Failed to upload the selected file",
  "Размер одного файла не должен превышать 100 МБ": "A single file must not exceed 100 MiB",
  "Общий размер вложений не должен превышать 250 МБ":
    "The total attachment size must not exceed 250 MiB",
  "Не удалось распознать запись": "Failed to transcribe the recording",
  "Не удалось скачать файл. Нажмите ещё раз.": "Failed to download the file. Click again.",
  "Просмотр файла {{name}}": "Viewing {{name}}",
  "Открыть {{name}}": "Open {{name}}",
  "открываем…": "opening…",
  "Скачать {{name}}": "Download {{name}}",
  Скачать: "Download",
  "Обновить предпросмотр": "Refresh preview",
  "Закрыть предпросмотр": "Close preview",
  "Вернуться к артефактам": "Back to artifacts",
  "Загружаем файл…": "Loading file…",
  "Не удалось открыть файл": "Could not open the file",
  "Файл мог быть перемещён или удалён.": "The file may have been moved or deleted.",
  "Файл слишком большой для предпросмотра": "The file is too large to preview",
  "Размер файла — {{size}}. Его можно скачать.":
    "The file is {{size}}. You can download it instead.",
  "Не удалось отобразить PDF": "Could not display the PDF",
  "Скачайте файл, чтобы открыть его в другом приложении.":
    "Download the file to open it in another app.",
  "Готовим страницы PDF…": "Preparing PDF pages…",
  "Не удалось скопировать": "Failed to copy",
  "Не удалось скопировать блок": "Failed to copy block",
  "Не удалось сохранить черновик": "Failed to save the draft",
  "Не удалось удалить сообщение из очереди": "Failed to delete the queued message",
  "Несовместимое событие": "Unsupported event",
  "Нет доступа к микрофону. Разрешите его в настройках приложения или браузера":
    "Microphone access is denied. Allow it in the app or browser settings",
  "Опишите проверяемый результат цели…": "Describe a verifiable goal outcome…",
  "Остановить задачу": "Stop task",
  "Остановить запись": "Stop recording",
  "Отменить запись": "Discard recording",
  "Отменить обработку записи": "Cancel recording processing",
  "Не удалось отменить обработку записи": "Failed to cancel recording processing",
  "Отправить сейчас": "Send now",
  "Отправляем запись": "Uploading recording",
  "Отправляем запись — не закрывайте": "Uploading recording — do not close",
  "Отправляется…": "Sending…",
  "Отредактированы файлы": "Files edited",
  "Очередь сообщений": "Message queue",
  "Ошибка копирования": "Copy failed",
  Переименовать: "Rename",
  "Изменить сообщение в очереди": "Edit queued message",
  План: "Plan",
  "Повторить загрузку старых сообщений": "Retry loading older messages",
  "Прочитаны файлы": "Files read",
  "Работал {{duration}}": "Worked for {{duration}}",
  "Распознавание не вернуло текст": "Speech recognition returned no text",
  "Распознаём · дольше прогноза на {{time}}": "Transcribing · {{time}} longer than estimated",
  "Распознаём · осталось ≈ {{time}}": "Transcribing · about {{time}} remaining",
  "Распознаём · прошло {{time}}": "Transcribing · {{time}} elapsed",
  Распознаём: "Transcribing",
  "Распознаём запись": "Transcribing recording",
  "Распознаём…": "Transcribing…",
  "Распознать и отправить": "Transcribe and send",
  "Режим голосового ввода": "Voice input mode",
  "Вставить в поле": "Insert into input",
  "Готовим отправку": "Preparing to send",
  "На сервере · готовим результат": "On the server · preparing the result",
  "На сервере · {{status}}": "On the server · {{status}}",
  Скопировано: "Copied",
  "Сначала отправьте или удалите аннотации": "Send or delete the annotations first",
  "Сначала отправьте или удалите аннотации к плану": "Send or delete the plan annotations first",
  "Сообщение будет добавлено в очередь": "The message will be added to the queue",
  "Сообщение для Codex": "Message for Codex",
  "Следующее изображение": "Next image",
  "Сохранить аннотацию": "Save annotation",
  "Спросите что угодно": "Ask anything",
  Удалить: "Delete",
  "Удалить сообщение из очереди": "Delete queued message",
  "Удалить аннотацию": "Delete annotation",
  "Удалить изображение {{name}}": "Delete image {{name}}",
  "Удалить файл {{name}}": "Delete file {{name}}",
  "Скачать файл {{name}}": "Download file {{name}}",
  "Удаляем…": "Deleting…",
  "Текст сообщения в очереди": "Queued message text",
  "Ход работы": "Progress",
  "Чтобы начать задачу, добавьте рабочую папку.": "Add a workspace folder to start a task.",
  "Этот браузер не поддерживает запись WebM или MP4":
    "This browser does not support WebM or MP4 recording",
  выполняется: "in progress",
  готово: "completed",
  ошибка: "failed",
  "скачиваем…": "downloading…",
  "Установка не управляется installer'ом CodexNest":
    "This installation is not managed by the CodexNest installer",
  "Управление доступно только при daemon-режиме Codex":
    "Management is available only when Codex runs in daemon mode",
  "Codex CLI или daemon недоступны. Установите Codex, выполните вход и запустите codexnest repair.":
    "Codex CLI or daemon is unavailable. Install Codex, sign in, and run codexnest repair.",
  "Файл прокси доступен группе или другим пользователям":
    "The proxy file is accessible to the group or other users",
  "Не удалось прочитать конфигурацию прокси": "Failed to read the proxy configuration",
  "Конфигурация прокси повреждена или противоречива":
    "The proxy configuration is corrupt or inconsistent",
};

export type TranslationVariables = Record<string, string | number>;
export type Translate = (key: string, variables?: TranslationVariables) => string;

type I18nContextValue = {
  language: UiLanguage;
  setLanguage(language: UiLanguage): void;
  t: Translate;
};

const fallbackContext: I18nContextValue = {
  language: "ru",
  setLanguage: () => undefined,
  t: (key, variables) => translate("ru", key, variables),
};

const I18nContext = createContext<I18nContextValue>(fallbackContext);

export function I18nProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<UiLanguage>(readInitialLanguage);

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next);
    localStorage.setItem(LANGUAGE_KEY, next);
    document.documentElement.lang = next;
  }, []);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, variables) => translate(language, key, variables),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function translate(
  language: UiLanguage,
  key: string,
  variables?: TranslationVariables,
): string {
  const template = language === "en" ? (ENGLISH[key] ?? key) : key;
  return interpolate(applicationText(template), variables);
}

export function localizeKnownServerText(
  language: UiLanguage,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (value === "Fast mode is not supported by the selected model") {
    return translate(language, "Fast mode недоступен для этой модели.");
  }
  if (value === "No speech was detected in the recording") {
    return language === "ru"
      ? "В записи не обнаружена речь. Проверьте микрофон и запишите ещё раз."
      : "No speech was detected. Check your microphone and record again.";
  }
  if (language === "ru") {
    if (value === "Search result changed; search again")
      return "История изменилась. Повторите поиск.";
    if (value === "Session history is unavailable") return "История сессии недоступна";
    if (value === "The draft changed before voice upload") {
      return "Черновик изменился; сохранённая запись не была потеряна. Повторите восстановление.";
    }
    if (value === "File exceeds the 100 MiB limit") {
      return "Размер одного файла не должен превышать 100 МБ";
    }
    if (value === "Attachments exceed the 250 MiB message limit") {
      return "Общий размер вложений не должен превышать 250 МБ";
    }
    if (value === "File attachment is unavailable") {
      return "Прикреплённый файл больше недоступен";
    }
    if (value === "Upload is too large") return "Загружаемый файл слишком большой";
    return value;
  }
  const direct = ENGLISH[value];
  if (direct) return direct;
  const execAmendment = /^Разрешать похожую команду: (.*)$/s.exec(value);
  if (execAmendment) return `Allow similar command: ${execAmendment[1]}`;
  const networkAmendment = /^(Разрешать|Запрещать) сеть для (.*)$/s.exec(value);
  if (networkAmendment) {
    return `${networkAmendment[1] === "Разрешать" ? "Allow" : "Deny"} network access for ${networkAmendment[2]}`;
  }
  return value;
}

export function readInitialLanguage(): UiLanguage {
  const stored = localStorage.getItem(LANGUAGE_KEY);
  if (stored === "en" || stored === "ru") return stored;
  return LEGACY_INSTALLATION_KEYS.some((key) => localStorage.getItem(key) !== null) ? "ru" : "en";
}

function interpolate(template: string, variables?: TranslationVariables): string {
  if (!variables) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(variables[name] ?? ""),
  );
}
