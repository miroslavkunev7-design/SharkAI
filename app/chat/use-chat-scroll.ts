import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react';

const FOLLOW_DISTANCE = 32;

export function useChatScroll(active: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFollowing = useRef(true);
  const [following, setFollowing] = useState(true);

  const updateFollowing = useCallback((next: boolean) => {
    if (isFollowing.current === next) return;
    isFollowing.current = next;
    setFollowing(next);
  }, []);

  const followLatest = useCallback(() => {
    updateFollowing(true);
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [updateFollowing]);

  const onScroll = useCallback(({ currentTarget }: UIEvent<HTMLDivElement>) => {
    updateFollowing(currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop <= FOLLOW_DISTANCE);
  }, [updateFollowing]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const thread = scroller?.firstElementChild;
    if (!active || !scroller || !thread) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!isFollowing.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (isFollowing.current) scroller.scrollTop = scroller.scrollHeight;
      });
    });
    observer.observe(scroller);
    observer.observe(thread);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active]);

  return { scrollRef, following, followLatest, onScroll };
}
