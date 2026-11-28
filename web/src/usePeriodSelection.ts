import { useLayoutEffect, useRef, useState, type FocusEvent } from 'react';

// Follow the current period until another period is selected. Defer following
// while focus or pending work occupies the period, so controls never disappear
// underneath keyboard users. Leaving the region catches up automatically.
export function usePeriodSelection<T extends HTMLElement>(current: string, pending = false) {
  const scope = useRef<T>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const value = selected ?? held ?? current;
  useLayoutEffect(() => {
    if (pending && held === null) setHeld(value);
    else if (!pending && held !== null && !scope.current?.contains(document.activeElement)) setHeld(null);
  }); // Also release focus holds when a focused control was removed without blur.
  const select = (next: string) => {
    setSelected(next === current ? null : next);
    setHeld(pending || scope.current?.contains(document.activeElement) ? next : null);
  };
  return {
    value, select, scope,
    onFocusCapture: () => setHeld(value),
    onBlurCapture: (event: FocusEvent<T>) => { if (!pending && !event.currentTarget.contains(event.relatedTarget)) setHeld(null); },
  };
}
