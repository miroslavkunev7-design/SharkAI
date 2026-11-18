# SharkAI

SharkAI е уеб работно пространство за AI чат, прикачени файлове, проекти и агентни задачи. Windows клиентът използва същата уеб услуга и същия акаунт, а при липса на връзка показва вграден екран за повторен опит.

## Локална разработка

Използвайте Node.js 24, PostgreSQL и стойностите, описани в `.env.example`. Следните команди подготвят празна тестова база и стартират приложението.

```bash
npm ci
npx prisma db push
npm run dev
```

Отворете `http://localhost:3847`. Чатът е на `/chat`, работното пространство е на `/dashboard`, а състоянието на Windows пакета е на `/download`.

За съществуваща база приложете добавъчните SQL файлове в `prisma/upgrade/` преди обновяване на уеб приложението. Архивите на новите проекти се записват в PostgreSQL. За старите проекти остава четене от съществуващото локално хранилище, когато файловете са достъпни.

## Настолен пакет

`npm run electron:build` изгражда `release/SharkAI-Setup-<версия>.exe` на Windows x64. Настройката `SHARKAI_DESKTOP_ORIGIN` задава разрешения HTTPS адрес при компилиране. Runner-ът изгражда и проверява пакета чрез `.github/workflows/windows-installer.yml`. За изтегляне от хоствания уеб интерфейс задайте HTTPS адреса на публикувания файл за същата версия в `INSTALLER_DOWNLOAD_URL`.

## Месечни абонаменти в SharkAI

- Приложете `prisma/upgrade/subscription-periods.sql` върху съществуваща PostgreSQL база преди обновяване на приложението. При чисто инсталиране полето идва от Prisma схемата.
- Настройте `NEXT_PUBLIC_APP_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` и `STRIPE_ULTRA_PRICE_ID`. Използвайте отделни месечни Stripe цени за Pro (€12) и Ultra (€28).
- Насочете Stripe webhooks към `/api/payments/webhook` за `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `charge.refunded`, `charge.dispute.created` и `radar.early_fraud_warning.created`. Достъп се предоставя за потвърдения платен период. Отказаното подновяване и обичайното прекратяване оставят вече платения период валиден до крайната му дата.
- Изпълнете `SHARKAI_TEST_BILLING=1 npx tsx scripts/test-billing.ts` с отделна PostgreSQL тестова база и приложена Prisma схема. За проверка на Stripe Checkout от край до край използвайте тестова Stripe среда и нейния webhook secret.

## Проверки

`npm test` проверява работещо приложение. Задайте `TEST_BASE`, ако то работи на друг адрес. За проверки със запис в база са нужни `TEST_USER_EMAIL` и `TEST_USER_PASSWORD` за отделен тестов акаунт. Тестът на инсталатора показва липсващ артефакт, когато текущата версия няма локален пакет.

За теста с два акаунта задайте тестовите PostgreSQL променливи и изпълнете `node scripts/test-workspace.cjs` срещу локалното приложение. `SHARKAI_TEST_CHAT_PROVIDER=1` включва проверката с реалния конфигуриран модел.

Вижте [приемателния отчет](docs/SHARKAI_ACCEPTANCE_BG.md) за проверения обхват и зависимостите.
