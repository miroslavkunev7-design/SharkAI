# SharkAI — Deploy стъпки (продължение)

## Проблем (открит сега)

Supabase интеграцията `supabase-camel-lever` е **Suspended** — базата не отговаря:
```
tenant/user postgres.bxtxygakafwusstpptkg not found
```

Затова Vercel deploy дава: **Resource provisioning failed**

---

## Решение (5 мин в браузър)

### Вариант A — Възстанови същата база
1. Отвори Supabase dashboard:
   ```
   vercel integration open supabase supabase-camel-lever
   ```
   Или: https://supabase.com/dashboard → проект `bxtxygakafwusstpptkg`
2. Ако пише **Paused** → **Restore project**
3. В Vercel → mm-auto → Settings → Integrations → Reconnect Supabase
4. Пусни локално:
   ```bash
   vercel env pull .vercel/.env.production.local --environment=production --yes
   node scripts/setup-production-db.cjs
   vercel --prod --yes
   ```

### Вариант B — Нова Supabase база
1. https://vercel.com/nadq-jeleva-s-projects/mm-auto/stores
2. Add Integration → Supabase → Create new
3. Connect to mm-auto
4. `vercel env pull` + `node scripts/setup-production-db.cjs` + `vercel --prod`

---

## Какво вече е направено

- ✅ `.vercelignore` — installer (1GB) не се качва
- ✅ Supabase reconnect — POSTGRES env vars попълнени
- ✅ `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET` в Vercel
- ✅ SEO: `/sitemap.xml`, `/robots.txt`, JSON-LD на `/download`
- ✅ 18/18 теста локално

## Production URL (след успешен deploy)

https://mm-auto-nadq-jeleva-s-projects.vercel.app

## Installer за download страницата

Качи `release/SharkAI-Setup-*.exe` на GitHub Releases и добави в Vercel:
```
INSTALLER_DOWNLOAD_URL=https://github.com/.../releases/download/.../SharkAI-Setup.exe
INSTALLER_SIZE_MB=120
```
