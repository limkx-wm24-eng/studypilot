import { useEffect, useState } from 'react';
import { api } from './api';

let config: Promise<{ emailEnabled: boolean }> | undefined;
export function useEmailAvailability() {
  const [enabled, setEnabled] = useState<boolean>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    config ??= api.get<{ emailEnabled: boolean }>('/api/config').then((result) => {
      if (typeof result.emailEnabled !== 'boolean') throw new Error('Invalid configuration');
      return result;
    });
    config.then((result) => { if (active) setEnabled(result.emailEnabled); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  return { emailEnabled: enabled, notice: failed ? 'Email availability could not be checked. Reload to try again.' : 'Checking email availability...' };
}
