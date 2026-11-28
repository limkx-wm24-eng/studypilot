import { randomBytes, scrypt } from 'node:crypto';

// Independent native fixture; never used by application routes or printed.
export async function strongPasswordFixture(password = 'synthetic-password-123'): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve,reject) => scrypt(password, salt, 64,
    { N: 16384, r: 8, p: 5, maxmem: 34*1024*1024 }, (error,key) => error ? reject(error) : resolve(key)));
  return `scrypt$v1$N=16384,r=8,p=5$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function weakPasswordFixture(N: 8192 | 16384 = 16384, password = 'synthetic-password-123'): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve,reject) => scrypt(password,salt,64,
    {N,r:8,p:1,maxmem:34*1024*1024},(error,key)=>error?reject(error):resolve(key)));
  return `scrypt$v1$N=${N},r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;
}
