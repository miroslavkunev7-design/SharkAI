# SharkAI — архив на локалното предаване

Актуалните стъпки за работния клон, съществуващата база и Windows пакета са в [README](README.md) и [приемателния отчет](docs/SHARKAI_ACCEPTANCE_BG.md). Описаният по-долу локален статус е от 14 юни 2026 г.

**Дата:** 2026-06-14  
**Проект:** `c:\Users\milena\mm-auto`  
**Статус:** **18/18 теста ✓** · Локално готово · Deploy подготвен

---

## Какво е готово

| Област | Статус |
|--------|--------|
| 15 агенти + 18 features | ✓ |
| Отворен чат (instant/normal/deep) | ✓ |
| Контекстни отговори (не health при „как си") | ✓ |
| Admin API ключове + toggle платен AI | ✓ |
| Test suite UI + pipeline graph | ✓ |
| Windows installer + Desktop shortcut | ✓ |
| Download страница + SEO + sitemap | ✓ |
| Администраторски достъп | ✓ |

---

## URL-и (локално)

| Страница | URL |
|----------|-----|
| Начало | http://localhost:3847 |
| Чат | http://localhost:3847/chat |
| Studio | http://localhost:3847/dashboard |
| Admin | http://localhost:3847/admin |
| Тестове | http://localhost:3847/tests |
| Изтегляне | http://localhost:3847/download |
| Sitemap | http://localhost:3847/sitemap.xml |

---

## Тестове — 18/18 ✓

```bash
cd c:\Users\milena\mm-auto
npm run dev
npm run test
```

**Категории:** Assets, Config, API, Chat (5), Upload, Build (6), SEO, Desktop, Download

---

## Deploy за Google („shark ai" / „шарк аи")

### Стъпка 1 — Vercel
```bash
npm i -g vercel
vercel login
vercel --prod
```

### Стъпка 2 — Env в Vercel
```
NEXT_PUBLIC_APP_URL=https://твоят-домейн.com
JWT_SECRET=...
DATABASE_URL=postgresql://...   # SQLite НЕ работи на Vercel
ADMIN_EMAIL=<existing-admin-email>
ADMIN_PASSWORD=...
INSTALLER_DOWNLOAD_URL=https://downloads.example.com/SharkAI-Setup-1.0.2.exe
INSTALLER_SIZE_MB=116.135466
```

### Стъпка 3 — Installer
- Локално: `npm run electron:build` → `release/SharkAI-Setup-*.exe`
- Качи .exe на **GitHub Releases** или Cloudinary Blob
- Във Vercel замени примерния хост в `INSTALLER_DOWNLOAD_URL` с действителния HTTPS адрес на публикувания файл. Името за версия 1.0.2 е `SharkAI-Setup-1.0.2.exe`.

### Стъпка 4 — Домейн + Google
1. Свържи домейн в Vercel
2. Google Search Console → submit `https://домейн/sitemap.xml`

---

## Команди

```bash
npm run dev
npm run test
npm run electron:build
npm run desktop:shortcut
npm run build
```

---

## Следващи стъпки

1. **Vercel deploy** + Postgres (Supabase/Neon) за production DB
2. **GitHub Release** с .exe
3. Реален домейн (sharkai.app или друг)
4. Тестове за останалите 12 screenshot/voice features (по желание)

---

## Ограничения

- Не commit без изрична заявка
- `release/` — голям файл, не в git
- OpenAI в `.env` — disabled освен ако Admin включи платен AI
