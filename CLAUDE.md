# Память проекта (для следующих сессий)

Обновлено 2026-11-08. Описание устройства и API в `README.md`, инструкции по развёртыванию на
старом ноутбуке в `docs/macos-server.md` и `docs/linux-mint-server.md`.

## Состояние кода

- Вся работа ноября 2026 (журнал наблюдений, раздача карты из сервера, инструкции для ноутбука,
  исправление nginx) лежит в ветке `claude/awesome-heisenberg-v7kmqp`. В `main` её ещё нет: при
  следующей работе сначала проверить, слита ли ветка, и при необходимости слить.
- Инструменты: Node 22, pnpm 10.28, `pnpm test` (shared + server, 63 теста), `pnpm typecheck`,
  `pnpm build`. Коммиты на английском в повелительном наклонении, документация на русском.
- Сервер пишет историю в `DATA_DIR/observations/<дата сервиса>.jsonl` (формат и анализ: README,
  раздел «История наблюдений»; `pnpm observations -- summary|export|report [--dir …]`).

## Текущее развёртывание (сборщик истории)

- Железо: MacBook Air 11" Mid 2013, хост `air`, пользователь `air`. Linux Mint 22.3 Xfce на
  разделе `sda4` (30 ГБ) рядом с macOS Sierra. **Обязателен параметр ядра `intel_iommu=off`**, без
  него Linux не видит Apple SSD; он закреплён в `/etc/default/grub`, меню GRUB показывается 5 с.
  Wi-Fi через `bcmwl-kernel-source`. Сон запрещён (`sleep.target` и др. замаскированы, крышка
  игнорируется).
- Проект: `~/myciti` на ветке выше, запущен через `docker compose up -d --build` (nginx на 8080 +
  сервер). Обновление: `cd ~/myciti && git pull && docker compose up -d --build`.
- Доступ: Tailscale установлен, Funnel проксирует 8080 на публичный https-адрес вида
  `https://air.<tailnet>.ts.net` (точный адрес: `tailscale funnel status` на Air). Внутри tailnet
  карта по `http://air:8080`, дома по `http://air.local:8080`. SSH: `ssh air@air.local`.
- Данные лежат в томе Docker: `/var/lib/docker/volumes/myciti-data/_data/observations`. Забрать:
  `ssh air@air 'sudo tar czf - -C /var/lib/docker/volumes/myciti-data/_data observations' > observations.tgz`,
  затем `pnpm observations -- summary --dir ./observations`.
- Сбор начат 2026-11-08 около 19:00 SAST, все маршруты, интервалы по умолчанию (карта работает).
  План: копить минимум неделю-две, затем этап 2 из README (история в движке: время хода по перегонам
  по часам и дням недели, ожидаемое отклонение до появления живых отметок, качество прогнозов сайта).
  Отчёт `report` пока не исключает suspect-рейсы.

## Грабли, на которые уже наступали

- nginx в Docker-образе не знал тип `.mjs`: воркер MapLibre отдавался как octet-stream и карта была
  пустой при живом API. Исправлено в `web/nginx.conf`; браузеры, успевшие закэшировать файл, нужно
  открыть в приватной вкладке или очистить данные сайта.
- Загрузка Mint на Mac: Esc в GRUB показывает меню, второй Esc выбрасывает в консоль `grub>`
  (выход: `normal`); в режиме правки Ctrl+X не работает, загрузка по fn+F10; в консоли `initramfs`
  команда `normal` не существует, нужен `reboot` и правка строки `linux`.
- Установщик Big Sur из App Store на Sierra качает заглушку и падает с «требуется загрузить
  содержимое»; обходы: полный `InstallAssistant.pkg` или Option+Cmd+R. Путь с Mint выбран вместо этого.
- Команды `rm -rf` с путями с пробелами на macOS пользователь набирал вручную и дважды удалил не ту
  папку. Опасные команды давать только для вставки целиком, лучше предлагать Finder.
