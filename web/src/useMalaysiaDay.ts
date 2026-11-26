import { useLayoutEffect, useState } from 'react';
import { malaysiaDay, nextMalaysiaMidnight } from './dateOnly';

// One instance per authenticated shell, independent of tasks and permissions.
export function useMalaysiaDay(enabled = true) {
  const [today, setToday] = useState(() => malaysiaDay());
  useLayoutEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number;
    const check = () => {
      if (!active) return;
      window.clearTimeout(timer);
      const now = new Date();
      setToday(malaysiaDay(now));
      timer = window.setTimeout(check, Math.max(1, nextMalaysiaMidnight(now) - now.getTime()));
    };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible); };
  }, [enabled]);
  return today;
}
