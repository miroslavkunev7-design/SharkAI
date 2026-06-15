# SharkAI — Handoff за следващ чат (100% тестове)

**Дата:** 2026-06-14  
**Проект:** `c:\Users\milena\mm-auto`  
**Статус:** 12/12 теста минаха (100%). Локално готово за ползване.

---

## Какво е SharkAI

Next.js 15 + Electron + SQLite/Prisma — локална AI платформа без задължително OpenAI плащане.

- **15 агенти**, **18 features**
- Отворен чат (всяка тема, не само софтуер)
- Screenshot → код + ZIP
- Windows installer + download страница

---

## URL-и (локално)

| Страница | URL |
|----------|-----|
| Начало | http://localhost:3847 |
| Чат | http://localhost:3847/chat |
| Studio | http://localhost:3847/dashboard |
| Тестове (графа + зелени тикове) | http://localhost:3847/tests |
| Изтегляне | http://localhost:3847/download |
| Installer API | http://localhost:3847/api/download/installer |

**Admin:** `mkunev77@abv.bg` / `Mirko0099!`

---

## Тестове — 12/12 ✓

```bash
cd c:\Users\milena\mm-auto
npm run dev          # порт 3847
npm run test         # CLI — записва .test-results.json
```

UI: http://localhost:3847/tests — pipeline graph + зелен тик на всеки минал тест, Retry Failed за неуспешни.

| ID | Име | Категория |
|----|-----|-----------|
| files-logo | Logo & icon files | Assets |
| files-agents | 18 features + 15 agents | Config |
| api-status | GET /api/status | API |
| api-chat-casual | „как си?" | Chat |
| api-chat-open | Космос въпрос | Chat |
| api-upload | Upload screenshot | Upload |
| build-screenshot | 30+ files + ZIP | Build |
| build-api-gen | API Generator | Build |
| build-db-gen | Database Generator | Build |
| preview-html | Preview HTML | Build |
| installer-file | Windows .exe | Desktop |
| download-route | GET /api/download/installer | Download |

---

## Desktop & installer

```bash
npm run electron:build    # компилира release/*Setup*.exe (дълго)
npm run desktop:shortcut  # SharkAI.lnk на Desktop с icon.ico
npm run logo:process      # регенерира икони
```

Shortcut: ако няма инсталиран Electron app → стартира `npm run dev` + отваря браузър.

---

## Chat скорост (tier system)

- **instant** (<800ms): здравей, как си, шеги, благодаря, кратки писания
- **fast**: кратки последващи въпроси
- **normal**: съвет, мнение, храна, пътуване
- **deep**: build, screenshot, наука, философия, дълги задачи

API връща `tier` + `latencyMs`. DB записът е в background — отговорът не чака базата.

- `lib/ai/config.ts` — `SHARKAI_USE_PAID_AI=true` само ако искаш платен OpenAI
- По подразбиране: `lib/ai/local-chat.ts` + `lib/ai/supreme-conversation.ts`
- Build: `lib/orchestrator.ts`, `lib/multi-agent-build.ts`, `lib/agent-pipeline.ts`

---

## Download / SEO (готово в кода, нужен deploy за Google)

- `app/download/page.tsx` — Shark AI / Шарк АИ landing
- `app/layout.tsx` — keywords: Shark AI, Шарк АИ, шарк аи
- `public/sitemap.xml`, `public/robots.txt` → домейн `sharkai.app` (placeholder)

### За да излиза в Google при търсене „shark ai" / „шарк аи":

1. Регистрирай домейн (напр. sharkai.app)
2. Deploy на Vercel: `vercel --prod` от проекта
3. Качи installer отделно (Blob/CDN/GitHub Releases) — Vercel serverless не е идеален за 100MB+ .exe
4. Обнови `sitemap.xml` и `robots.txt` с реалния домейн
5. Google Search Console — submit sitemap

**Засега:** потребителите ползват локално (localhost или Desktop shortcut / installer).

---

## Ключови файлове

```
lib/ai/supreme-conversation.ts   # отворен чат
lib/ai/config.ts                 # local-only gate
lib/orchestrator.ts              # build pipeline
lib/agents.ts                    # 18 features, 15 agents
scripts/test-suite.cjs           # тестове
app/tests/page.tsx               # UI графа + тикове
app/download/page.tsx            # download landing
app/api/download/installer/route.ts
app/api/tests/route.ts
electron/main.cjs
public/icon.ico
release/                         # SharkAI-Setup.exe
.test-results.json               # последни резултати
```

---

## Команди за старт

```bash
cd c:\Users\milena\mm-auto
npm run dev
npm run desktop:shortcut
```

Отвори Desktop **SharkAI** или http://localhost:3847

---

## Следващи стъпки (ако потребителят иска)

1. Deploy на Vercel + реален домейн за публично търсене
2. GitHub Release с .exe за CDN download
3. По-голям test suite (всички 18 features поотделно)
4. Electron auto-update

---

## Ограничения

- Не commit-вай без изрична заявка от потребителя
- OpenAI ключ в `.env` — disabled по подразбиране
- `release/` може да е голям — не качвай в git без LFS
