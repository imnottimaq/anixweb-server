# Задание AGY: исправления комнат и интеграция прокси

## Цель и разрешённые действия

Реализовать этот план в двух существующих репозиториях:
- сервер: `C:/Users/Tymofii Saukh/Projects/anixweb-server`;
- клиент: `C:/Users/Tymofii Saukh/Projects/anixweb`.

Пользователь просит выполнить работу **с использованием сабагентов**. Используй
три параллельных сабагента с границами владения ниже; сам координируй интеграцию,
проверку diff и итоговые тесты. Сохрани существующие незакоммиченные изменения.
Не делай deploy, commit, push и не изменяй production secrets. Не читай и не
выводи `.dev.vars`/токены. Проверки запускай с тестовыми binding и ключами.

## Подтверждённая исходная ситуация

- Сервер уже реализует Worker, RoomObject, RoomDirectory, протокол v2 и комнатные сессии.
- `npm test`: 33/33 passed. `npm run build`: passed (dry-run, без deploy).
- Браузерный тест реально прошёл MP4, HLS, ожидание 7 с, late catch-up,
  пользовательскую паузу и смену качества, но упал на неоднозначном h2 selector.
- Проверка создания использует `String(data.visibility)`: `visibility:["private"]`
  проходит, сохраняется массивом и позволяет второму аккаунту войти по roomId без
  приглашения. Воспроизведение на Miniflare: create=200, joinWithoutCode=200.
- RoomDirectory читает все `room:` перед slice(21) и сканирует их при уборке.
- Integration next() может вернуть историческое сообщение и ложно подтвердить replay.

## Сабагент A — Worker, прокси, auth, протокол и интеграционные утверждения

Владение: `src/worker.ts`, `src/auth.ts`, новые `src/proxy.ts` и модуль общего UA,
`protocol/index.ts`, `tests/worker.test.ts`, новые proxy tests, server env/docs.

### 1. Строгая валидация

При создании принимать только `visibility === 'private' || visibility === 'public'`.
Не преобразовывать arrays/objects в строку. В общем валидаторе убрать String()
из проверок visibility, playback.intent и participant.status. При загрузке
невалидного сохранённого room state отказывать явно, не превращать его в public
и не удалять данные. Добавить защиту проверки private access по умолчанию:
неизвестная visibility никогда не открывает доступ. Синхронизацию общего
протокола с клиентом выполняет координатор после завершения параллельных правок.

### 2. Встроить пользовательский прокси

Исходный код пользователя — совместимые маршруты `/agentproxy?url=...` и
`/corsproxy?url=...`, методы GET/HEAD/POST/OPTIONS, передача request.body,
`redirect:'manual'`, allowlist из двух точных HTTPS-хостов:
`kodikplayer.com`, `api-s.anixsekai.com`. Agent route подставляет этот **точный** UA:

```text
AnixartApp/9.0 BETA 7-25082901 (Android 9; SDK 28; x86_64; ROG ASUS AI2201_B; ru)
```

Реализовать исходник как читаемый TypeScript-модуль, без esbuild helpers из
присланного bundle. Тот же UA применять в прямой auth-проверке `/profile/info`.
Установка user-agent в corsproxy не требуется.

Маршрутизировать прокси после проверки Origin и до требования SESSION_SECRET:
прокси не требует комнатной сессии и работает для неавторизованных операций.
Использовать существующий точный ALLOWED_ORIGINS, без wildcard. Проксирование не
проходит через RoomObject и JSON-only body() с лимитом 8 KiB.

URL: HTTPS, точные два hostname, без username/password, порт только стандартный
443, без разрешения произвольных CDN/поддоменов. Redirect не следовать автоматически;
при проксировании redirect возвращать явную ошибку PROXY_REDIRECT_BLOCKED (502),
чтобы браузер не обходил политику посредством Location. Это намеренное уточнение
исходного manual redirect: исходник мог передать Location браузеру.

Forward request headers: Accept, Accept-Language, Content-Type, Api-Version,
Range, If-Range, If-None-Match, If-Modified-Since. Не пересылать Cookie,
Authorization, Host, Origin, Referer и присланный User-Agent. Agent UA задаётся
сервером. OPTIONS должен разрешать перечисленные headers и методы для прокси.

JSON, urlencoded и multipart сохранять байт-в-байт; multipart boundary не менять.
Максимум POST body — 9 MiB (клиент допускает avatar file до 8 MiB плюс multipart).
Проверять заявленный и фактический размер до upstream fetch; накопление ограничить
этим лимитом. GET/HEAD без body. Timeout получения upstream response — 15 секунд;
abort клиента передавать upstream. Не повторять POST автоматически.

Ответы стримить, сохранить status и content-type, Content-Range, Accept-Ranges,
ETag/Last-Modified. Как в исходнике удалить Set-Cookie и Content-Length; убрать
upstream CORS и применить собственную политику. Expose Content-Type,
Content-Range, Accept-Ranges, ETag, Last-Modified. Credential-bearing API ответы
делать Cache-Control:no-store. Ошибки — фиксированные коды без error.message,
URL/токенов/тел запросов. Проксирование должно сохранить 206 и 416 ответы.

Для agentproxy ввести лимит 60 запросов/IP/минуту с отдельным ключом directory,
для corsproxy — 600 запросов/IP/минуту. Не расходовать room creation/join quota.

Тестировать proxy через тестовый upstream service binding, который нельзя
переопределить произвольным production URL. Сохранить ANIXART_TEST semantics,
обновить assertion короткого UA на полный UA.

### 3. Свежие подтверждения replay

Добавить checkpoint сообщения и `nextAfter(checkpoint,predicate)` (или эквивалент).
После оригинального ack записать revision. Повторить commandId и дождаться
**нового** ack после checkpoint; revision/mediaVersion неизменны. Регрессия
helper: старое подходящее сообщение не завершает новый wait.

## Сабагент B — ограниченный каталог и миграция

Владение: `src/objects.ts`, новый `tests/directory.test.ts` и отдельные helpers
каталога, если понадобятся. Не редактировать общие worker tests агента A.

Сохранить namespace `directory-v2`, канонические `room:`, `code:`, `limit:` keys.
Добавить `public:{roomId}` для активных публичных комнат и сортируемые
`expiry:{13-digit timestamp}:{kind}:{canonicalKey}` записи для reservation/limit.
Индексы и канонические данные поддерживать одной storage transaction.

`/list`: только prefix public:, limit 21, startAfter public:{cursor}; возвращать
20 элементов и UUID двадцатого как следующий cursor при наличии 21-го.
Уборка: партии до 100 истёкших expiry keys, перед удалением перечитать canonical
record и сравнить актуальный срок. Просроченная индексная запись не удаляет
продлённый лимит или активированную комнату. Alarm планировать по первому expiry;
если осталась просроченная партия — продолжить коротким alarm, без полного скана.

Миграция существующих room:/limit: keys партиями по 100, с durable stage/cursor.
Не выполнять весь backfill в constructor/blockConcurrencyWhile. Пока индекс не
готов, /list возвращает 503 DIRECTORY_MIGRATING, остальные операции продолжаются.
Для пустой базы миграция завершается сразу. Транзакции должны перечитывать записи,
чтобы concurrent update/remove не воскресил старую комнату. Все storage.list()
в каталоге должны иметь конечный limit, включая миграцию и alarms.

Тесты: >40 public rooms вперемешку с private; страницы без пропусков/дубликатов;
public->private, close/remove, reservation->active; устаревшие expiry;
>100 expiry records; возобновление миграции после reconstruction; изменение/
удаление между партиями; instrumented assertion finite list limits.

## Сабагент C — клиентская маршрутизация прокси и browser test

Владение: клиентский proxy helper, `apiClient.ts`, `LinkParser.ts`,
`PlayerScreen.tsx`, `EditAccountScreen.tsx`, client tests/env/docs;
серверный `tests/browser.mjs`. Не менять `roomProtocol.ts` вручную.

Создать единый helper построения proxy URL. Для API и разрешённых Kodik requests
использовать базу `VITE_PROXY_SERVER_URL`, по умолчанию VITE_ROOM_SERVER_URL
(локально http://localhost:8787), и новые server routes. Не дописывать /api/v2
к proxy paths. Кодировать target query ровно один раз, нормализовать trailing slash.

**Выбранный безопасный default совместимости:** новый server сохраняет двуххостовый
allowlist пользователя. Cors requests к другим providers/CDN пока маршрутизируются
через отдельно задаваемый `VITE_MEDIA_PROXY_URL`, default
https://kodik-proxy.imnottimaq.workers.dev. Это сознательная совместимость, не retry:
destination выбирается до запроса. Agent API не откатывается на старый прокси.
Не расширять сервер до произвольных media URLs. Этот default можно изменить,
только если пользователь явно выберет полный перенос и даст политику медиадоменов.

Убрать разрозненные литералы старого Worker из API/parser/player и двух inline
agentproxy URLs в EditAccountScreen (обновление профиля, multipart avatar).
Старый адрес остаётся только в централизованном media default и документации.
Не ломать прямой AniLibria fetch. Сохранить HLS retry: только status=0, один раз,
original callback URL, Range, abort signal. Не переписывать сейчас Sibnet/VK/OK
redirect resolution, поскольку они остаются на legacy media proxy.

Browser test: вместо '#watch-room-panel h2' использовать конкретный panel header
heading. После Transfer host дождаться диалога 'Make viewer2 the host?' и нажать
его scoped 'Transfer host'; после Leave ведущего подтвердить в 'Leave this room?'
кнопкой 'Leave room'. Проверить cancel сохраняет роль/членство и передача не
происходит до подтверждения. Menu target выбирать по accessible name участника.
В browser fixture проксировать разрешённые API через настоящий Worker с fixture
upstream; не подменять сам новый proxy response напрямую в Playwright.

Client tests: обе базы/trailing slashes, двойное кодирование query, разрешённые
и legacy media destinations, все agent methods и avatar callers, fallback once,
Api-Version/Range и отмена. Внешний origin allowlist должен включать локальный
frontend; production origins не менять автоматически.

## Координатор AGY: порядок и критерии готовности

1. Запустить три сабагента параллельно с указанным владением.
2. Проверить их изменения, конфликтующие Env/types/docs согласовать самому.
3. Выполнить server `npm run sync:protocol` после изменений strict validation.
4. Server: npm test; npm run build; npm run test:browser.
5. Client: npm test; npm run lint; npm run build.
6. Проверить git diff --check и отсутствие случайного удаления текущих изменений.
7. Повторить exploit visibility:["private"]: создание возвращает 400; корректная
   private room по-прежнему требует code для нового аккаунта.
8. Убедиться, что каталог не выполняет unbounded list, replay ждёт новый ack,
   полный браузерный тест проходит до конца, а новый proxy сохраняет full UA,
   multipart, Api-Version и media Range и не раскрывает credentials в логах.
9. Итог: что изменено, фактические результаты команд, ограничения media whitelist.
   Реальную production API-проверку без токена пользователя не заявлять выполненной.

Важные инварианты комнат: ожидание максимум 7 секунд без kick; late catch-up;
user Pause никогда не отменяется readiness timeout; ручная передача хоста;
случайная передача при leave и через 7 секунд после обнаруженного disconnect.
