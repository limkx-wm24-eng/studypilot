const WINDOW = 15 * 60_000;
const PAIR_LIMIT = 5;
const IP_LIMIT = 30;
const MAX_KEYS = 4096;
type Counter = { failures: number[]; pending: number };

export class LoginLimits {
  private readonly pairs = new Map<string, Counter>();
  private readonly ips = new Map<string, Counter>();
  constructor(private readonly clock = () => Date.now()) {}
  private prune(now: number) {
    for (const map of [this.pairs, this.ips]) for (const [key, entry] of map) {
      entry.failures = entry.failures.filter((time) => time > now - WINDOW);
      if (!entry.pending && !entry.failures.length) map.delete(key);
    }
  }
  begin(email: string | undefined, ip: string): { retryAfter: number } | { finish(success: boolean, failure?: boolean): number | undefined } {
    const now = this.clock();
    this.prune(now);
    const key = JSON.stringify([email ?? '', ip]);
    // Refuse new keys at capacity rather than evicting an active lockout.
    if ((!this.pairs.has(key) && this.pairs.size >= MAX_KEYS) || (!this.ips.has(ip) && this.ips.size >= MAX_KEYS)) return { retryAfter: 60 };
    const pair = this.pairs.get(key) ?? { failures: [], pending: 0 };
    const aggregate = this.ips.get(ip) ?? { failures: [], pending: 0 };
    const retries = [[pair, PAIR_LIMIT], [aggregate, IP_LIMIT]].flatMap(([raw, limit]) => {
      const entry = raw as Counter;
      return entry.failures.length + entry.pending >= Number(limit)
        ? [entry.failures.length >= Number(limit) ? Math.max(1, Math.ceil((entry.failures[0] + WINDOW - now) / 1000)) : 1] : [];
    });
    if (retries.length) return { retryAfter: Math.max(...retries) };
    this.pairs.set(key, pair); this.ips.set(ip, aggregate);
    pair.pending++; aggregate.pending++;
    let finished = false;
    return { finish: (success, failure = true) => {
      if (finished) return;
      finished = true; pair.pending--; aggregate.pending--;
      if (success) pair.failures = [];
      else if (failure) { const time = this.clock(); pair.failures.push(time); aggregate.failures.push(time); }
      const retries = [[pair, PAIR_LIMIT], [aggregate, IP_LIMIT]].flatMap(([raw, limit]) => {
        const entry = raw as Counter;
        return entry.failures.length >= Number(limit) ? [Math.max(1, Math.ceil((entry.failures[0] + WINDOW - this.clock()) / 1000))] : [];
      });
      return retries.length ? Math.max(...retries) : undefined;
    } };
  }
}
