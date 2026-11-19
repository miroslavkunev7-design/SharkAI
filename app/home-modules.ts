import { LayoutDashboard, MessageSquare, PanelsTopLeft, Wallet, ChartNoAxesCombined } from 'lucide-react';

export const homeModules = [
  {
    id: 'chat', tile: 'Шарк агент', title: 'Шарк агент', icon: MessageSquare,
    href: '/chat', action: 'Отвори чата',
    description: 'Обсъждай идеи, работи с файлове и продължавай разговорите си с основния агент на Shark AI.',
    summary: 'Разговори и инструменти',
  },
  {
    id: 'investments', tile: 'Инвестиции', title: 'Инвестиции', icon: ChartNoAxesCombined,
    href: '/dashboard?view=investments', action: 'Отвори инвестициите',
    description: 'Сравнявай стратегии, следи пазарните цени и виж напредъка към целта си.',
    summary: 'Стратегии, калкулатор и пазари',
  },
  {
    id: 'studio', tile: 'Студио', title: 'Студио', icon: PanelsTopLeft,
    href: '/dashboard?view=studio', action: 'Към Студиото',
    description: 'Създай проект от описание или екранна снимка и проследи изпълнението му.',
    summary: 'Проекти от описание или референция',
  },
  {
    id: 'wallet', tile: 'Портфейл', title: 'Портфейл', icon: Wallet,
    href: '/wallet', action: 'Отвори портфейла',
    description: 'Виж баланса, движенията и разрешенията на свързаната си сметка.',
    summary: 'Баланс и движения по сметката',
  },
  {
    id: 'work', tile: 'Работа', title: 'Работно пространство', icon: LayoutDashboard,
    href: '/dashboard', action: 'Отвори работното пространство',
    description: 'Виж текущите проекти и достъпните модули на SharkAI от едно място.',
    summary: 'Обзор на проектите и модулите',
  },
] as const;
