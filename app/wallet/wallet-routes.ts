export const walletTitles = {
  overview: 'Начало', transactions: 'Последни транзакции', transaction: 'Транзакция', payments: 'Плащания',
  currencies: 'Конвертор', crypto: 'Крипто', cards: 'Карти', details: 'Детайли на сметката',
  investments: 'Инвестиции', forecast: 'Прогноза', settings: 'Настройки', analytics: 'Анализи',
  search: 'Търси', profile: 'Профил', more: 'Още', accounts: 'Сметки и джобове',
  move: 'Премести', 'account-actions': 'Действия по сметката', 'add-money': 'Захрани',
  transfer: 'Превод', withdraw: 'Изтегли', exchange: 'Обмяна', request: 'Поискай пари',
  scheduled: 'Планирани плащания', 'wise-connection': 'Връзка с Wise', pockets: 'Джобове в Wise',
  'new-account': 'Нова сметка', 'new-pocket': 'Нов джоб', hidden: 'Скрити сметки',
  pocket: 'Джоб', 'pocket-edit': 'Редактиране на джоб', 'pocket-transfer': 'Прехвърляне към джоб',
  card: 'Карта', 'card-details': 'Данни на картата', 'card-settings': 'Настройки на картата',
  'card-limit': 'Лимит на картата', 'card-security': 'Защита на картата', 'card-activity': 'Движения по картата',
  'new-card': 'Нова карта', 'card-order': 'Поръчка на карта', 'card-delivery': 'Доставка на карта',
  'card-pin': 'ПИН на картата', 'card-terminate': 'Закриване на карта', beneficiaries: 'Получатели',
  'new-beneficiary': 'Нов получател', 'payment-result': 'Състояние на плащането', 'transfer-review': 'Преглед на превода',
  'exchange-review': 'Преглед на обмяната', 'add-money-review': 'Преглед на захранването',
  'market-search': 'Търсене на пазари', asset: 'Актив', trade: 'Сделка', 'trade-review': 'Преглед на сделката',
  orders: 'Поръчки', order: 'Поръчка', holdings: 'Наличности', notifications: 'Известия',
  security: 'Сигурност', privacy: 'Поверителност', help: 'Помощ', chat: 'Shark Assistant',
  'request-result': 'Платежна заявка', 'scheduled-detail': 'Планирано плащане',
  'trade-result': 'Състояние на поръчката', 'crypto-receive': 'Получи крипто',
  'crypto-send': 'Изпрати крипто', 'crypto-send-review': 'Преглед на изпращането', 'investment-fund': 'Инвестиционна сметка',
} as const;

export type WalletRoute = keyof typeof walletTitles;
const aliases: Record<string, WalletRoute> = {
  home: 'overview', invest: 'investments', 'account-new':'new-account', 'pocket-new':'new-pocket',
  'card-new':'new-card', 'card-spend':'card-activity',
};
export function readWalletRoute(value: unknown): WalletRoute {
  if (typeof value !== 'string') return 'overview';
  if (Object.hasOwn(walletTitles, value)) return value as WalletRoute;
  return Object.hasOwn(aliases, value) ? aliases[value] : 'overview';
}
export const walletUrl = (route: WalletRoute) => route === 'overview' ? '/wallet' : '/wallet?tab='+route;
export const walletLogin = (route: WalletRoute) => '/login?next='+encodeURIComponent(walletUrl(route));
