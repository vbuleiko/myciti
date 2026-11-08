# Тихий сервер на старом MacBook

Как поднять карту и сбор истории на одном ноутбуке (проверено в расчёте на MacBook Air 11" Mid 2013)
одним процессом Node, без Docker и nginx, с автозапуском и доступом из интернета.

## 0. macOS

Нужна macOS 11 Big Sur или новее: на более старой системе не запускается Node 22. Mid 2013 Air
официально обновляется до Big Sur. Перед обновлением сделайте резервную копию и освободите
35–40 ГБ.

1. Скачайте установщик Big Sur из App Store: <https://apps.apple.com/app/macos-big-sur/id1526878132>
   (на Sierra ссылка открывает App Store, установщик появится в «Программах»).
2. Запустите «Установка macOS Big Sur» и дождитесь конца (около часа, несколько перезагрузок).
3. Проверьте: в Терминале `sw_vers` должна показать `ProductVersion: 11.x`.

Big Sur больше не получает обновлений безопасности. Для домашней машины, на которой крутится один
этот процесс и которая не выставляет порты в интернет напрямую, это приемлемо, но не пользуйтесь
на ней браузером и почтой.

## 1. Не спать

Питание от сети, крышку можно закрыть:

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 5 autorestart 1
```

```bash
sudo pmset -a disablesleep 1
```

`autorestart 1` включает ноутбук после пропадания и возврата электричества. В «Системных
настройках → Пользователи и группы → Параметры входа» включите автоматический вход для своего
пользователя, иначе после перезагрузки агенты launchd не стартуют до входа в систему.

## 2. Инструменты

1. Node 22 LTS: скачайте `.pkg` для macOS x64 с <https://nodejs.org/en/download> и установите.
2. pnpm и git:

```bash
corepack enable && corepack prepare pnpm@10.28.0 --activate
```

```bash
xcode-select --install
```

(вторая команда ставит Command Line Tools с `git`; если диалог говорит, что они уже есть, хорошо).

Проверка: `node -v` показывает `v22.x`, `pnpm -v` показывает `10.28.0`.

## 3. Проект

```bash
git clone https://github.com/vbuleiko/myciti.git ~/myciti && cd ~/myciti
```

```bash
pnpm install && pnpm build
```

Сборка кладёт сервер в `server/dist`, карту в `web/dist`. Сервер сам находит `web/dist` рядом и
раздаёт карту на том же порту, что и API (`WEB_DIST` в `.env.example`).

Настройки по желанию в `~/myciti/.env` (образец `.env.example`). Для карты оставьте интервалы
по умолчанию. Чтобы снизить нагрузку, можно ограничить маршруты: `ROUTES=101,T01,D01`.

Пробный запуск:

```bash
cd ~/myciti && pnpm start
```

Откройте <http://localhost:3000>: должна открыться карта, автобусы появятся через минуту-две.
macOS спросит, разрешить ли `node` принимать входящие соединения: разрешите. Остановите `Ctrl+C`.

## 4. Автозапуск

```bash
bash ~/myciti/deploy/macos/install.sh
```

Скрипт ставит агент launchd `za.myciti.server`: запуск при входе в систему, перезапуск при
падении, лог в `~/Library/Logs/myciti/server.log`. Проверка:

```bash
curl -s http://127.0.0.1:3000/api/health | head -c 300
```

Управление: `launchctl kickstart -k gui/$(id -u)/za.myciti.server` перезапускает,
`bash ~/myciti/deploy/macos/install.sh --remove` убирает агенты. После `git pull` нужны
`pnpm install && pnpm build` и перезапуск.

## 5. Доступ из интернета

Самый простой способ без настройки роутера и без аккаунтов: быстрый туннель Cloudflare.
Он отдаёт случайный адрес вида `https://слово-слово.trycloudflare.com`, который меняется при
перезапуске туннеля (при перезагрузке ноутбука).

```bash
curl -L -o /tmp/cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz && sudo tar -xzf /tmp/cf.tgz -C /usr/local/bin && cloudflared --version
```

```bash
bash ~/myciti/deploy/macos/install.sh --tunnel
```

Адрес появляется в логе через несколько секунд:

```bash
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/Library/Logs/myciti/cloudflared.log | tail -1
```

Откройте его с телефона через мобильный интернет. Адрес знают только те, кому вы его дали, но он
не секрет: API только для чтения, лишнего там нет.

Постоянный адрес: если у вас есть домен, добавьте его в бесплатный аккаунт Cloudflare и сделайте
именованный туннель (`cloudflared tunnel login`, `cloudflared tunnel create myciti`,
`cloudflared tunnel route dns myciti bus.ваш-домен`, затем `cloudflared service install`), подробности
в документации Cloudflare Tunnel. Другой вариант без туннеля: проброс порта 3000 на роутере плюс
бесплатный DDNS (DuckDNS), если провайдер даёт публичный IP. Это выставляет порт наружу, поэтому
для машины с Big Sur я бы предпочёл туннель.

## 6. Собранные данные

История пишется в `~/myciti/server/data/observations/`, по файлу на день сервиса. Через день-два
проверьте, что собирается:

```bash
cd ~/myciti && pnpm observations -- summary
```

Через неделю заберите каталог на основной компьютер (с него, подставив имя пользователя и адрес
ноутбука в сети; на MacBook должен быть включён «Удалённый вход» в настройках «Общий доступ»):

```bash
rsync -av user@macbook.local:myciti/server/data/observations/ ./observations/
```

Или просто заархивируйте папку и перекиньте через AirDrop. Формат описан в README, раздел
«История наблюдений».

## Если что-то не так

- `/api/health` отвечает, но карта пустая: подождите пару минут, первый цикл опроса идёт 70–90 с;
  в `health` смотрите `routes.*.lastError`.
- Агент не стартует: `~/Library/Logs/myciti/server.log`; типичная причина — не выполнен `pnpm build`
  или в `PATH` агента нет `node` (скрипт подставляет полный путь, но после переустановки Node путь
  может измениться: повторите `install.sh`).
- Ноутбук всё же засыпает: проверьте `pmset -g` (должно быть `sleep 0`, `disablesleep 1`) и что он
  на зарядке.
- Данных за ночь нет: это нормально, ночью рейсов нет и сервер почти не опрашивает сайт.
