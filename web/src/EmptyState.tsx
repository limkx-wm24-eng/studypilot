import type { ReactNode } from 'react';

export default function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path d="M13 8h17l7 7v25H13a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z" />
        <path d="M29 8v8h8M16 23h14M16 29h14M16 35h9" />
      </svg>
      <p>{children}</p>
    </div>
  );
}
