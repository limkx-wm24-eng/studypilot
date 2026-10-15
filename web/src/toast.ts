const TOAST_EVENT = 'studypilot:toast';

export function showToast(message: string) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: message }));
}

export function listenForToasts(listener: (message: string) => void) {
  const receive = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === 'string') listener(event.detail);
  };
  window.addEventListener(TOAST_EVENT, receive);
  return () => window.removeEventListener(TOAST_EVENT, receive);
}
