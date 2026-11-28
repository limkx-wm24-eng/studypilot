import { randomBytes, scryptSync } from 'node:crypto';
// The exact pre-upgrade algorithm, only for synthetic compatibility fixtures.
export function legacyHash(password: string) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}
