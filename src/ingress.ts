import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';

export const MAX_FORWARD_BYTES = 2048;
export const MAX_FORWARD_HOPS = 16;
const MAX_TRUSTED_RANGES = 32;
type Address = { canonical: string; family: 4 | 6; value: bigint };
type Range = { family: 4 | 6; low: bigint; high: bigint };

// Node validates syntax; URL serialization canonicalizes IPv6 compression/case.
// Ports, brackets, zone identifiers and non-canonical IPv4 encodings are rejected.
function address(raw: string): Address | undefined {
  if (typeof raw !== 'string' || raw.length > 45 || raw.includes('%')) return;
  const family = isIP(raw);
  if (family === 4) {
    const value = raw.split('.').reduce((n,part) => (n << 8n) | BigInt(part), 0n);
    return { canonical: raw, family: 4, value };
  }
  if (family !== 6) return;
  const canonical = new URL(`http://[${raw}]/`).hostname.slice(1,-1);
  const halves = canonical.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  const value = groups.reduce((n,part) => (n << 16n) | BigInt(`0x${part}`), 0n);
  if ((value >> 32n) === 0xffffn) {
    const v4 = value & 0xffffffffn;
    return { family: 4, value: v4, canonical: [24n,16n,8n,0n].map(shift => Number((v4 >> shift)&255n)).join('.') };
  }
  return { canonical, family: 6, value };
}
export const normalizeClientIp = (raw: string) => address(raw)?.canonical;

function trustedRange(raw: string): Range {
  const parts = raw.split('/');
  const ip = address(parts[0]);
  if (!ip || parts.length > 2) throw new Error('TRUSTED_PROXY_CIDRS must contain IP addresses or CIDRs');
  const originallyV6 = isIP(parts[0]) === 6;
  const originalBits = originallyV6 ? 128 : 32;
  const prefix = parts.length === 1 ? originalBits : /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : -1;
  if (prefix < 1 || prefix > originalBits) throw new Error('Unrestricted or invalid proxy CIDR is forbidden');
  const normalizedPrefix = originallyV6 && ip.family === 4 ? prefix - 96 : prefix;
  const bits = ip.family === 4 ? 32 : 128;
  if (normalizedPrefix < 1 || normalizedPrefix > bits) throw new Error('Unrestricted or ambiguous mapped proxy CIDR is forbidden');
  const span = 1n << BigInt(bits-normalizedPrefix);
  const low = (ip.value/span)*span;
  return { family: ip.family, low, high: low+span-1n };
}
function coversAll(ranges: readonly Range[], family: 4 | 6): boolean {
  const ordered = ranges.filter(r=>r.family===family).sort((a,b)=>a.low<b.low?-1:a.low>b.low?1:0);
  let end = -1n;
  for (const range of ordered) {
    if (range.low > end+1n) return false;
    if (range.high > end) end=range.high;
  }
  return end === (1n << BigInt(family===4?32:128))-1n;
}
class IngressRejection extends Error {
  constructor(readonly status: 400 | 403) { super('Request not allowed'); }
}
export type IngressConfig = Readonly<{
  mode: 'direct' | 'trusted-proxy';
  resolve(peer: string | undefined, rawHeaders: readonly string[]): string;
}>;

export function loadIngressConfig(env: NodeJS.ProcessEnv = process.env): IngressConfig {
  const mode = env.INGRESS_MODE ?? (env.NODE_ENV === 'production' ? undefined : 'direct');
  if (mode !== 'direct' && mode !== 'trusted-proxy') throw new Error('INGRESS_MODE must be explicitly direct or trusted-proxy in production');
  const configured = env.TRUSTED_PROXY_CIDRS ?? '';
  if (configured.length > 4096) throw new Error('TRUSTED_PROXY_CIDRS exceeds its configuration bound');
  if (mode === 'direct' && configured.trim()) throw new Error('Direct ingress cannot also configure trusted proxies');
  const entries = configured ? configured.split(',').map(s=>s.trim()) : [];
  if (mode === 'trusted-proxy' && (!entries.length || entries.length > MAX_TRUSTED_RANGES)) throw new Error('Trusted-proxy ingress requires 1–32 explicit peer addresses/CIDRs');
  const ranges = entries.map(trustedRange);
  if (coversAll(ranges,4) || coversAll(ranges,6)) throw new Error('Unrestricted proxy trust is forbidden, including combined CIDRs');
  const trusted = (ip: Address) => ranges.some(r=>r.family===ip.family && ip.value>=r.low && ip.value<=r.high);
  return Object.freeze({ mode, resolve(peer: string | undefined, rawHeaders: readonly string[]) {
    const socket = peer === undefined ? undefined : address(peer);
    if (!socket) throw new IngressRejection(400);
    if (mode === 'direct') return socket.canonical; // No forwarding-header parsing.
    if (!trusted(socket)) throw new IngressRejection(403);
    let field: string | undefined;
    for (let i=0;i<rawHeaders.length;i+=2) if (rawHeaders[i].toLowerCase()==='x-forwarded-for') {
      if (field !== undefined) throw new IngressRejection(400);
      field = rawHeaders[i+1];
    }
    if (!field || field.length > MAX_FORWARD_BYTES || Buffer.byteLength(field,'utf8') > MAX_FORWARD_BYTES) throw new IngressRejection(400);
    // Bound split/allocation before parsing any addresses.
    const tokens = field.split(',');
    if (tokens.length > MAX_FORWARD_HOPS) throw new IngressRejection(400);
    const chain = tokens.map(token=>address(token.trim()));
    if (chain.some(ip=>!ip)) throw new IngressRejection(400);
    const valid = chain as Address[];
    if (new Set(valid.map(ip=>ip.canonical)).size !== valid.length) throw new IngressRejection(400);
    for (let i=valid.length-1;i>=0;i--) if (!trusted(valid[i])) return valid[i].canonical;
    throw new IngressRejection(400); // All-trusted chain has no distinct client.
  }});
}

const identities = new WeakMap<Request,string>();
export const clientIdentity = (req: Request): string => {
  const identity = identities.get(req);
  if (identity === undefined) throw new Error('Client identity is unavailable');
  return identity;
};
export function ingressBoundary(config: IngressConfig): RequestHandler {
  return (req,res,next) => {
    try { identities.set(req,config.resolve(req.socket.remoteAddress,req.rawHeaders)); }
    catch (error) {
      if (!(error instanceof IngressRejection)) return next(error);
      res.set('Cache-Control','no-store').status(error.status).json({error:'Request not allowed'});
      return;
    }
    next();
  };
}
