# M&M Auto

Диагностична платформа за **TCS CDP / VCI** кабел — Windows инсталация + iPad PWA.

## Бърз старт (демо)

```bash
cd c:\Users\milena\mm-auto
npm install
npm run dev
```

Отвори http://localhost:5173 и натисни **„Демо режим (без кабел)"**.

## Windows инсталация

```bash
npm run electron:build
```

Инсталаторът ще е в папка `release/`.

## Свързване на TCS CDP кабел

1. Свържи кабела към USB и OBD-II порта на колата
2. Включи запалването (без да палиш двигателя)
3. В приложението избери COM порт (напр. COM3)
4. Натисни **„Свържи кабела"**
5. **„Прочети VIN от колата"** или **„Сканирай от кабела"**

## iPad — Добави на начален екран

1. Отвори в Safari: `http://[IP-на-PC]:5173`
2. Сподели → **Add to Home Screen**
3. Приложението се отваря като standalone app

## Поддържани марки

24+ марки, 100+ модела — VW, Audi, BMW, Mercedes, Ford, Toyota, Hyundai и др.
