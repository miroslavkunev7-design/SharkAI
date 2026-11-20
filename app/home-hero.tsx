'use client';

import { useRef, useState, type KeyboardEvent, type TouchEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import sharkArtwork from '@/public/sharkai/shark-hero.webp';
import marketArtwork from '@/public/sharkai/markets.webp';
import studioArtwork from '@/public/sharkai/studio.webp';
import portfolioArtwork from '@/public/investment-lab/assets/investments.webp';
import teamArtwork from '@/public/sharkai/team.webp';
import { homeModules } from './home-modules';

const moduleArtwork = { chat: sharkArtwork, investments: marketArtwork, studio: studioArtwork, wallet: portfolioArtwork, work: teamArtwork };

export function HomeHero() {
  const [current, setCurrent] = useState(0);
  const swipe = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const slide = homeModules[current];

  function changeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const count = homeModules.length;
    const next = event.key === 'ArrowRight' ? (current + 1) % count
      : event.key === 'ArrowLeft' ? (current + count - 1) % count
      : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setCurrent(next);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  }

  function startSwipe(event: TouchEvent<HTMLElement>) {
    const target = event.target;
    swipe.current = null;
    if (event.touches.length !== 1 || (target instanceof Element && target.closest('button, a'))) return;
    const touch = event.touches[0];
    swipe.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp };
  }

  function finishSwipe(event: TouchEvent<HTMLElement>) {
    const start = swipe.current;
    swipe.current = null;
    if (!start || event.timeStamp - start.at > 700) return;
    const end = Array.from(event.changedTouches).find((touch) => touch.identifier === start.id);
    if (!end) return;
    const x = end.clientX - start.x;
    const y = end.clientY - start.y;
    if (Math.abs(x) < 56 || Math.abs(x) < Math.abs(y) * 1.5) return;
    const count = homeModules.length;
    setCurrent((value) => (value + (x < 0 ? 1 : count - 1)) % count);
  }

  return (
    <section className="shark-launch-hero" data-module={slide.id} aria-labelledby="home-title" onTouchStart={startSwipe} onTouchEnd={finishSwipe} onTouchCancel={() => { swipe.current = null; }}>
      <div className="shark-launch-art" aria-hidden="true">
        <Image src={moduleArtwork[slide.id]} alt="" fill priority={current === 0} sizes="(max-width: 760px) 100vw, (max-width: 1040px) 78vw, 820px" />
      </div>
      <div className="shark-launch-content">
        <div className="shark-launch-tiles" role="group" aria-label="Избери модул">
          {homeModules.slice(0, 4).map(({ id, tile, icon: Icon }, index) => (
            <button key={id} type="button" aria-pressed={index === current} onClick={() => setCurrent(index)}>
              <Icon size={30} aria-hidden="true" /> <span>{tile}</span>
            </button>
          ))}
        </div>
        <div className="shark-launch-copy" data-module={slide.id} aria-live="polite">
          <h1 id="home-title">{slide.title}</h1>
          <p>{slide.description}</p>
          <Link href={slide.href} className="shark-action shark-launch-primary">
            {slide.action}<ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      </div>
      <div className="shark-launch-pages" role="group" aria-label="Изгледи на SharkAI" onKeyDown={changeByKey}>
        {homeModules.map(({ id, title }, index) => (
          <button key={id} type="button" aria-label={`Покажи ${title}`} aria-pressed={index === current} onClick={() => setCurrent(index)} />
        ))}
      </div>
    </section>
  );
}
