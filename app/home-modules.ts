import { LayoutDashboard, MessageSquare, PanelsTopLeft, Store, Wallet, ChartNoAxesCombined } from 'lucide-react';

export const homeModules = [
  {
    id: 'chat', tile: 'Шарк агент', title: 'Шарк агент', icon: MessageSquare, scene: 'assistant', cardScene: 'tools',
    href: '/chat', action: 'Отвори чата',
    description: 'Обсъждай идеи, работи с файлове и продължавай разговорите си с основния агент на Shark AI.',
    summary: 'Разговори и инструменти',
  },
  {
    id: 'investments', tile: 'Инвестиции', title: 'Инвестиции', icon: ChartNoAxesCombined, scene: 'investments', cardScene: 'markets',
    href: '/dashboard?view=investments', action: 'Отвори инвестициите',
    description: 'Сравнявай стратегии, следи пазарните цени и виж напредъка към целта си.',
    summary: 'Стратегии, калкулатор и пазари',
  },
  {
    id: 'studio', tile: 'Студио', title: 'Студио', icon: PanelsTopLeft, scene: 'studio', cardScene: 'canvas',
    href: '/dashboard?view=studio', action: 'Към Студиото',
    description: 'Създай проект от описание или екранна снимка и проследи изпълнението му.',
    summary: 'Проекти от описание или референция',
  },
  {
    id: 'wallet', tile: 'Портфейл', title: 'Портфейл', icon: Wallet, scene: 'wallet', cardScene: 'payments',
    href: '/wallet', action: 'Отвори портфейла',
    description: 'Виж баланса, движенията и разрешенията на свързаната си сметка.',
    summary: 'Баланс и движения по сметката',
  },
  {
    id: 'commerce', tile: 'Търговия', title: 'Търговия', icon: Store, scene: 'commerce', cardScene: 'orders',
    href: '/dashboard?view=commerce', action: 'Отвори търговията',
    description: 'Прегледай капитала, поръчките и приходите от свързания магазин.',
    summary: 'Капитал и поръчки от магазина',
  },
  {
    id: 'work', tile: 'Работа', title: 'Работно пространство', icon: LayoutDashboard, scene: 'workspace', cardScene: 'projects',
    href: '/dashboard', action: 'Отвори работното пространство',
    description: 'Виж текущите проекти и достъпните модули на SharkAI от едно място.',
    summary: 'Обзор на проектите и модулите',
  },
] as const;
