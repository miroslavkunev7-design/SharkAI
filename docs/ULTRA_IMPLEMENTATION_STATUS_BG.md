# SharkAI ULTRA — проверена архитектура и карта на маршрутите
Дата: 20.11.2026. Източник: оригиналното `miroslavkunev7-design/SharkAI` (branch `master`) и потребителските одобрени референции.

## Техническа рамка и неизменяеми зависимости
- Next.js 15, React 19, TypeScript, Prisma/PostgreSQL; действителен домейн/production Vercel проект **не е установен** в наличните два Vercel акаунта.
- Съществуващият `app/layout.tsx` вече монтира **точно един** `QuickChatWidget` глобално; агентът е `ChatWorkspace` от `app/chat/chat-workspace.tsx`. Вече има реална разговорна логика; не създавай втори агент.
- `app/wallet/wallet-home.tsx` използва `GET /api/wallet-investments` и `POST /api/wallet-investments/provider/transactions`. Не прави демо стойности на мястото на удостоверения Wise отговор.
- Актуалният Wallet разполага с 4 таба. Някои допълнителни табове от Sites прототипа не са доказано налични като backend в оригиналния проект.
- Работещият Stripe/абонаментен поток, администраторският ULTRA план, оригиналният n8n, OAuth и крипто/инвестиционни мандати остават изцяло отделени от визуалните промени.

## Действително установени маршрути и действия
| Потребителски елемент | Реален път или ефект | Верификация / обхват |
|---|---|---|
| Home на сайта | `/` | `app/page.tsx`, `app/home-hero.tsx` |
| „Шарк агент“ | `/chat` | `app/chat/page.tsx` и същият ChatWorkspace |
| Плаващ чат | Глобален `QuickChatWidget` | Всички страници освен самото `/chat`; не е втори агент |
| Студио | `/dashboard?view=studio` | `app/dashboard/page.tsx` |
| Архив на агенти | `/dashboard?view=agents` | Същият dashboard router |
| Автомобили | `/dashboard?view=automotive` | Същият dashboard router |
| Инвестиции | `/dashboard?view=investments` | Същият dashboard router |
| Магазин и препродажба | `/dashboard?view=commerce` | Същият dashboard router |
| Профил/Настройки | `/dashboard?view=settings` | Същият dashboard router |
| Wallet „Начало“ | `/wallet` | Overview; live state from owner dashboard |
| Wallet „Движения“ | `/wallet?tab=transactions` | Сървърно разрешено извлечение от Wise |
| Wallet „Прогноза“ | `/wallet?tab=forecast` | Аналитичен модул; НЕ е гаранция за доходност |
| Wallet „Настройки“ | `/wallet?tab=settings` | Избор и отнемане на достъп, реални server handlers |
| Wallet „Захрани“ / „Изпрати“ / „Изтегли“ | Контекстен панел + `https://wise.com/home/` | Самото действие се потвърждава в Wise; приложението няма право да изпрати средства самостоятелно |
| Официален вход | `/login` | Реална авторизация; не използвай фалшив акаунт |
| Windows приложение | `/download` | Съществуващ модул |

**Предвидени, но НЕпотвърдени в оригиналния backend:** самостоятелен таб „Карти“ с метаданни на Wise виртуална карта, таб „Валути“ с реален конвертор, крипто плащания вътре в Wallet. Дръж ги изключени или показвай действителното състояние без да създаваш неавторизирани финансови операции. Добавят се само при установени права и API източник.

## Поредица на изпълнение
1. **Wallet skin**: импорт на `wallet-approved-theme.css` след оригиналния `wallet.css`, без промяна на `wallet-home.tsx` и `/api/wallet-investments`.
2. **Локални assets**: копирай всички оригинални `public/sharkai/wallet/*.webp` и `public/sharkai/chat/*.webp` от одобрения `SharkAI_Production_Wallet_UI_Patch.zip`; това е **задължително**, защото CSS ги използва. Няма други допустими заместители.
3. **Глобални токени**: `app/sharkai-ultra.css`, импорт веднъж от `app/layout.tsx`; единни хедър, икони, glass/ice, типография и glow без подмяна на рендерираните секции.
4. **Global agent**: остави един `QuickChatWidget`, `ChatWorkspace` и всички вече работещи API/integrations. Използвай approved-coast, approved-wave-header, shark-avatar за точно одобрения визуален слой.
5. **Маршрути и функционалност**: за всяка съществуваща страница проверявай видими истински `href`, действия, auth, back и loading/error/empty. Нови маршрути само след проверена необходимост, данни и права.
6. **Build and QA**: `npm ci`, `npm run build`, `npm test`, браузърни screenshots 393px/430px/1440px, Wise status scenarios, проверки на регистрация/ULTRA/chat/документи.
7. **Deploy**: само в еднозначно установения production Vercel проект на оригиналния сайт. Запиши SHA, build, производствен домейн и screenshot. При липсващи права или assets — блокирай deploy, без измислен успех.

## Заключени визуални референции
- Портфейл mobile: `references/approved-mobile.jpeg` от ZIP.
- Портфейл desktop: `references/approved-desktop-layout.jpeg` за **подредба**, не за различен дизайн.
- Чат: `references/chat-approved-visual.png`; оригиналният вечерен бряг с ледено преливане, лилаво-син хедър, лайм съобщения, перлени отговори.
- Цветове: #071c39, #10365c, #073ca2, #6b29d2, #4317a2, #22dcff, #effcff и #b9ff19 за съобщенията на потребителя.
- Ледената текстура стига до **самите заоблени краища**; тематичните снимки се маскират плавно и не закриват текстове. Не рисувай второ вътрешно правоъгълно изображение върху готовата карта.

## Приемателни проверки / доказателства
- [x] Установено действително оригинално хранилище и бекенд маршрути за Wallet и чат.
- [x] Подготвени additive CSS файлове и включени в UI кода **на отделен GitHub branch**.
- [x] Съществуващият общ чат компонент е запазен (без клониране).
- [ ] Одобрените **бинарни assets са записани в оригиналния GitHub repo** — предстои upload на WebP файловете от ZIP.
- [ ] Проверен `npm run build` на целия оригинален репозиторий.
- [ ] Преглед в браузър срещу одобрения mobile/desktop еталон.
- [ ] Проверени Wise собственик, права, профил, валута и реален provider response.
- [ ] Идентифициран и достъпен оригиналният production Vercel проект.
- [ ] Успешен production deploy и наблюдавана работа на истинския домейн.

Нито една непроверена точка не се представя като завършена. Не се активират покупки, плащания или инвестиционни операции.