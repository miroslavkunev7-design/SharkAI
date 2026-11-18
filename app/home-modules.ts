import { BrainCircuit, LayoutDashboard, MessageSquare, PanelsTopLeft, UsersRound } from 'lucide-react';

export const homeModules = [
  {
    id: 'brain', tile: 'Мозък', title: 'Supreme Brain', icon: BrainCircuit,
    href: '/dashboard?view=agents#supreme-brain', action: 'Отвори Supreme Brain',
    description: 'Координирай AI агентите и проследявай изпълнението на проектите си.',
    summary: 'Координация на проекти',
  },
  {
    id: 'chat', tile: 'Чат', title: 'AI чат', icon: MessageSquare,
    href: '/chat', action: 'Отвори AI чата',
    description: 'Задавай въпроси, прикачвай файлове и продължавай разговорите си.',
    summary: 'Разговори и работа с файлове',
  },
  {
    id: 'studio', tile: 'Студио', title: 'Студио', icon: PanelsTopLeft,
    href: '/dashboard?view=studio', action: 'Към Студиото',
    description: 'Създай проект от описание или екранна снимка и проследи изпълнението му.',
    summary: 'Проекти от описание или референция',
  },
  {
    id: 'agents', tile: 'Агенти', title: 'AI агенти', icon: UsersRound,
    href: '/dashboard?view=agents#agent-roles', action: 'Виж агентите',
    description: 'Разгледай специализираните роли, наличността и резултатите им по проекти.',
    summary: 'Роли и резултати по проекти',
  },
  {
    id: 'work', tile: 'Работа', title: 'Работно пространство', icon: LayoutDashboard,
    href: '/dashboard', action: 'Отвори работното пространство',
    description: 'Виж текущите проекти и достъпните модули на SharkAI от едно място.',
    summary: 'Обзор на проектите и модулите',
  },
] as const;
