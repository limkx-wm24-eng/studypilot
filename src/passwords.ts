import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const PASSWORD_POLICY = Object.freeze({ N: 16384, r: 8, p: 1 });
export const PASSWORD_MAXMEM = 34 * 1024 * 1024;
export const HASH_ACTIVE_LIMIT = 2;
export const HASH_QUEUE_LIMIT = 8;
export const AUTH_BUSY_MESSAGE = 'Authentication is busy. Please try again shortly.';
export class PasswordQueueFull extends Error {
  constructor() { super(AUTH_BUSY_MESSAGE); }
}

// One queue per process, shared by every route and service instance.
export class HashQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly maximum = HASH_ACTIVE_LIMIT, private readonly capacity = HASH_QUEUE_LIMIT) {}
  get status() { return { active: this.active, waiting: this.waiting.length }; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.maximum) this.active++;
    else {
      if (this.waiting.length >= this.capacity) throw new PasswordQueueFull();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // Transfer the existing permit; a new arrival cannot steal it.
      else this.active--;
    }
  }
}
export const passwordQueue = new HashQueue();
type Parameters = { N: number; r: number; p: number };
type Parsed = Parameters & { salt: Buffer; key: Buffer; legacy: boolean };
export type Derive = (password: string, salt: Buffer, parameters: Parameters) => Promise<Buffer>;
const nativeDerive: Derive = (password, salt, parameters) => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: parameters.N, r: parameters.r, p: parameters.p, maxmem: PASSWORD_MAXMEM }, (error, key) => error ? reject(error) : resolve(key));
});

// A deliberately small supported profile set prevents stored data from allocating
// arbitrary memory or CPU. Support the current profile, legacy, and an older
// N=8192 profile. More costly unrecognized profiles are rejected, never downgraded.
function parse(stored: string): Parsed | undefined {
  if (typeof stored !== 'string' || stored.length > 240) return;
  const legacy = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(stored);
  if (legacy) return { N: 16384, r: 8, p: 1, salt: Buffer.from(legacy[1], 'hex'), key: Buffer.from(legacy[2], 'hex'), legacy: true };
  const versioned = /^scrypt\$v1\$N=(8192|16384),r=8,p=1\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(stored);
  if (versioned) return { N: Number(versioned[1]), r: 8, p: 1, salt: Buffer.from(versioned[2], 'hex'), key: Buffer.from(versioned[3], 'hex'), legacy: false };
}
export function needsPasswordUpgrade(stored: string, target: Parameters = PASSWORD_POLICY): boolean {
  const parsed = parse(stored);
  if (!parsed) return false;
  // Only move to a policy that dominates every cost parameter. Never downgrade.
  return parsed.N <= target.N && parsed.r <= target.r && parsed.p <= target.p
    && (parsed.legacy || parsed.N < target.N || parsed.r < target.r || parsed.p < target.p);
}

const dummySalt = randomBytes(16);
export class PasswordService {
  constructor(private readonly queue = passwordQueue, private readonly derive: Derive = nativeDerive) {}
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.queue.run(() => this.derive(password, salt, PASSWORD_POLICY));
    return `scrypt$v1$N=${PASSWORD_POLICY.N},r=${PASSWORD_POLICY.r},p=${PASSWORD_POLICY.p}$${salt.toString('hex')}$${key.toString('hex')}`;
  }
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    return this.queue.run(async () => {
      const key = await this.derive(password, parsed.salt, parsed);
      return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
    });
  }
  async verifyLogin(password: string, stored?: string): Promise<boolean> {
    const parsed = stored === undefined ? undefined : parse(stored);
    return this.queue.run(async () => {
      // Current/legacy/unknown use N=16384. Older N=8192 gets another N=8192
      // dummy operation, keeping the supported failure profiles at similar work.
      const parameters = parsed ?? PASSWORD_POLICY;
      const key = await this.derive(password, parsed?.salt ?? dummySalt, parameters);
      const valid = !!parsed && key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
      if (parameters.N < PASSWORD_POLICY.N) await this.derive(password, dummySalt, { ...PASSWORD_POLICY, N: parameters.N });
      return valid;
    });
  }
}
export const passwords = new PasswordService();
export const hashPassword = (password: string) => passwords.hash(password);
export const checkPassword = (password: string, stored: string) => passwords.verify(password, stored);
