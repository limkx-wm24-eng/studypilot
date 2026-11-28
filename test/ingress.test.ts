import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { loadIngressConfig, normalizeClientIp, clientIdentity, MAX_FORWARD_BYTES, MAX_FORWARD_HOPS } from '../src/ingress.js';
import { createApp } from '../src/app.js';
import { openTestDb } from './support/database.ts';
import { HashQueue, PasswordService, AUTH_BUSY_MESSAGE } from '../src/passwords.js';
import { securityHarness } from './support/securityHarness.ts';

const cfg=(peers='127.0.0.2/32')=>loadIngressConfig({NODE_ENV:'production',INGRESS_MODE:'trusted-proxy',TRUSTED_PROXY_CIDRS:peers});
const close=(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
type Target={port:number};
async function proxy(target:Target,source:string,append=true){
  const server=createServer((req,res)=>{
    const headers={...req.headers};
    // Actual edge behavior: append the observed socket peer, never a test selector.
    if(append) headers['x-forwarded-for']=[headers['x-forwarded-for'],req.socket.remoteAddress].filter(Boolean).join(', ');
    const upstream=request({host:'127.0.0.1',port:target.port,localAddress:source,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  }).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  return {server,port:(server.address() as AddressInfo).port,close:()=>close(server)};
}
async function fixture(mode:ReturnType<typeof loadIngressConfig>,passwords?:PasswordService){
  const db=await openTestDb();
  const app=createApp(db,{ingress:mode,passwords,mailer:{enabled:false,async send(){}}});
  app.get('/__synthetic_identity',(req,res)=>res.json({client:clientIdentity(req),host:req.hostname,protocol:req.protocol}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  return {app,port:(server.address() as AddressInfo).port,db,async close(){await close(server);await db.close();}};
}
const send=(port:number,path='/__synthetic_identity',headers:IncomingHttpHeaders|readonly string[]= {},source='127.0.0.1',method='GET',body?:unknown)=>new Promise<{status:number;headers:IncomingHttpHeaders;body:any}>((resolve,reject)=>{
  const outgoing=request({host:'127.0.0.1',port,localAddress:source,path,method,headers:headers as IncomingHttpHeaders},incoming=>{
    let text='';incoming.on('data',chunk=>{text+=chunk;});incoming.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:incoming.statusCode!,headers:incoming.headers,body});});
  });outgoing.on('error',reject);if(body!==undefined)outgoing.write(JSON.stringify(body));outgoing.end();
});

for(const [raw,canonical] of [
  ['192.0.2.1','192.0.2.1'],['::ffff:192.0.2.1','192.0.2.1'],['0:0:0:0:0:FFFF:C000:0201','192.0.2.1'],
  ['2001:0DB8:0000:0000:0000:0000:0000:0001','2001:db8::1'],['2001:db8::1','2001:db8::1'],['::1','::1'],
] as const)test(`canonical IP accepts supported representation ${raw}`,()=>assert.equal(normalizeClientIp(raw),canonical));
test('invalid identity encodings are rejected without guessing or accepting ports/zones',()=>{
  for(const raw of ['','unknown','010.0.0.1','999.0.0.1','192.0.2.1:80','[::1]:80','[::1]','fe80::1%lo','2001:::1','"192.0.2.1"','for=192.0.2.1',' 192.0.2.1','x'.repeat(4096)])assert.equal(normalizeClientIp(raw),undefined);
});
test('production ingress requires explicit bounded configuration and rejects universal trust',()=>{
  assert.throws(()=>loadIngressConfig({NODE_ENV:'production'}),/INGRESS_MODE/);
  for(const mode of ['','true','false','1','loopback','*'])assert.throws(()=>loadIngressConfig({NODE_ENV:'production',INGRESS_MODE:mode}));
  for(const peers of ['', '*','true','loopback','0.0.0.0/0','::/0','0.0.0.0/1,128.0.0.0/1','::/1,8000::/1','192.0.2.1/33','2001:db8::/129','::ffff:0.0.0.0/96','192.0.2.1,','x'.repeat(4097),Array(33).fill('192.0.2.1').join(',')])assert.throws(()=>cfg(peers));
  assert.throws(()=>loadIngressConfig({INGRESS_MODE:'direct',TRUSTED_PROXY_CIDRS:'127.0.0.2'}));
  assert.equal(loadIngressConfig({NODE_ENV:'development'}).mode,'direct');
  assert.equal(cfg('::ffff:127.0.0.2/128').resolve('127.0.0.2',['X-Forwarded-For','192.0.2.1']),'192.0.2.1');
  assert.equal(cfg('192.0.2.0/24').resolve('192.0.2.2',['X-Forwarded-For','203.0.113.1']),'203.0.113.1');
});
test('trusted resolution bounds chains, rejects ambiguity and stops at the nearest untrusted peer',()=>{
  const config=cfg('127.0.0.2/32,127.0.0.3/32');
  assert.equal(config.resolve('127.0.0.2',['X-Forwarded-For','198.51.100.1,203.0.113.1,127.0.0.3']),'203.0.113.1');
  assert.equal(config.resolve('127.0.0.2',['X-Forwarded-For','::ffff:192.0.2.1']),'192.0.2.1');
  for(const chain of ['','unknown','192.0.2.1,,203.0.113.1','192.0.2.1,192.0.2.1','2001:db8::1,2001:0db8:0:0:0:0:0:1','127.0.0.3','192.0.2.1:80',' '.repeat(MAX_FORWARD_BYTES)+'192.0.2.1',Array.from({length:MAX_FORWARD_HOPS+1},(_,i)=>`192.0.2.${i+1}`).join(',')])assert.throws(()=>config.resolve('127.0.0.2',['X-Forwarded-For',chain]));
  assert.throws(()=>config.resolve('127.0.0.2',['X-Forwarded-For','192.0.2.1','x-forwarded-for','203.0.113.1']));
  assert.throws(()=>config.resolve(undefined,[]));assert.throws(()=>config.resolve('not-an-ip',[]));
});
test('actual direct sockets ignore forged and malformed forwarding headers',async()=>{
  const f=await fixture(loadIngressConfig({INGRESS_MODE:'direct'}));
  try{
    for(const headers of [{},{'X-Forwarded-For':'192.0.2.1'},{'X-Forwarded-For':'invalid'},{'X-Forwarded-For':'2001:db8::1','Forwarded':'for=203.0.113.1','X-Real-IP':'203.0.113.1','CF-Connecting-IP':'203.0.113.2','X-Forwarded-Host':'foreign.example.test','X-Forwarded-Proto':'https'}]){
      const result=await send(f.port,undefined,headers);assert.equal(result.status,200);assert.equal(result.body.client,'127.0.0.1');assert.equal(result.body.protocol,'http');assert.equal(result.body.host,'127.0.0.1');
    }
  }finally{await f.close();}
});
test('actual proxy boundary defeats preceding attacker values and rejects untrusted direct access',async()=>{
  const f=await fixture(cfg()),p=await proxy(f,'127.0.0.2');
  try{
    const direct=await send(f.port,'/api/auth/login',{'X-Forwarded-For':'192.0.2.1'});assert.equal(direct.status,403);assert.equal(direct.headers['cache-control'],'no-store');
    for(const headers of [{},{'X-Forwarded-For':'203.0.113.1'},{'X-Forwarded-For':'203.0.113.2'}]){
      const result=await send(p.port,undefined,headers);assert.equal(result.status,200);assert.equal(result.body.client,'127.0.0.1');
    }
    assert.equal((await send(f.port,undefined,{},'127.0.0.2')).status,400,'A trusted socket must still supply a client chain');
  }finally{await p.close();await f.close();}
});
test('two real proxies peel only explicitly trusted intermediaries',async()=>{
  const f=await fixture(cfg('127.0.0.2/32,127.0.0.3/32'));
  const inner=await proxy(f,'127.0.0.2'),outer=await proxy(inner,'127.0.0.3');
  try{const result=await send(outer.port,undefined,{'X-Forwarded-For':'203.0.113.1'});assert.equal(result.status,200);assert.equal(result.body.client,'127.0.0.1');}
  finally{await outer.close();await inner.close();await f.close();}
  const other=await fixture(cfg()),last=await proxy(other,'127.0.0.2'),unexpected=await proxy(last,'127.0.0.3');
  try{const result=await send(unexpected.port,undefined,{'X-Forwarded-For':'203.0.113.1'});assert.equal(result.status,200);assert.equal(result.body.client,'127.0.0.3','Unknown intermediary becomes the conservative identity; its claimed predecessor is not trusted');}
  finally{await unexpected.close();await last.close();await other.close();}
});
test('duplicate raw headers, excessive chains and malformed values are rejected before hashing',async()=>{
  class Counting extends PasswordService {calls=0;override verifyLogin(password:string,stored?:string){this.calls++;return super.verifyLogin(password,stored);}}
  const service=new Counting(),f=await fixture(cfg(),service);
  try{
    const cases:(IncomingHttpHeaders|readonly string[])[]=[
      ['Host','synthetic.test','X-Forwarded-For','192.0.2.1','x-forwarded-for','203.0.113.1'],
      {'X-Forwarded-For':'invalid'},{'X-Forwarded-For':'192.0.2.1,'+' '.repeat(2048)+'203.0.113.1'},{'X-Forwarded-For':Array.from({length:17},(_,i)=>`192.0.2.${i+1}`).join(',')},
    ];
    for(const headers of cases){const result=await send(f.port,'/api/auth/login',headers,'127.0.0.2','POST',{email:'missing@example.test',password:'synthetic-password-123'});assert.equal(result.status,400);assert.deepEqual(result.body,{error:'Request not allowed'});assert.equal(result.headers['cache-control'],'no-store');}
    assert.equal(service.calls,0);
  }finally{await f.close();}
});
test('forwarded Host/protocol cannot bypass Origin protection through a trusted proxy',async()=>{
  const f=await fixture(cfg()),p=await proxy(f,'127.0.0.2');
  try{
    const response=await send(p.port,'/api/auth/register',{'Content-Type':'application/json',Origin:'https://foreign.example.test','X-Forwarded-Host':'foreign.example.test','X-Forwarded-Proto':'https'},'127.0.0.1','POST',{email:'synthetic@example.test',password:'synthetic-password-123'});
    assert.equal(response.status,403);assert.equal(response.headers['cache-control'],'no-store');assert.deepEqual(response.body,{error:'Request not allowed'});
    assert.ok(response.headers['content-security-policy']);
  }finally{await p.close();await f.close();}
});
test('canonical equivalent clients share token-consumption buckets and direct spoofing cannot reset lockouts',async()=>{
  const h=await securityHarness(true,false);
  try{
    for(let i=0;i<10;i++)assert.equal((await h.send('POST','/api/auth/reset',{},undefined,{'X-StudyPilot-Test-Client':i%2?'::ffff:192.0.2.20':'192.0.2.20'})).status,400);
    const limited=await h.send('POST','/api/auth/reset',{},undefined,{'X-StudyPilot-Test-Client':'192.0.2.20'});assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('Retry-After'))>0);
    for(let i=0;i<10;i++)assert.equal((await h.send('POST','/api/auth/verify-email',{},undefined,{'X-StudyPilot-Test-Client':i%2?'2001:db8::1':'2001:0DB8:0:0:0:0:0:1'})).status,400);
    assert.equal((await h.send('POST','/api/auth/verify-email',{},undefined,{'X-StudyPilot-Test-Client':'2001:db8::1'})).status,429);
  }finally{await h.close();}
});
test('rejected ingress does not enter a saturated queue; valid p=5 authentication recovers',async()=>{
  const queue=new HashQueue();let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});const service=new PasswordService(queue),f=await fixture(cfg(),service);
  const blockers=Array.from({length:10},()=>queue.run(()=>gate));
  try{
    assert.equal((await send(f.port,'/api/auth/login',{},'127.0.0.1','POST')).status,403);
    assert.equal((await send(f.port,'/api/auth/login',{},'127.0.0.2','POST')).status,400);
    assert.deepEqual(queue.status,{active:2,waiting:8});
    const busy=await send(f.port,'/api/auth/register',{'X-Forwarded-For':'192.0.2.1','Content-Type':'application/json'},'127.0.0.2','POST',{email:'synthetic@example.test',password:'synthetic-password-123'});
    assert.equal(busy.status,503);assert.deepEqual(busy.body,{error:AUTH_BUSY_MESSAGE});assert.equal(busy.headers['retry-after'],'1');
    release();await Promise.all(blockers);
    const success=await send(f.port,'/api/auth/register',{'X-Forwarded-For':'192.0.2.1','Content-Type':'application/json'},'127.0.0.2','POST',{email:'synthetic@example.test',password:'synthetic-password-123'});assert.equal(success.status,201);
    assert.ok(String((await f.db.get('SELECT password_hash FROM users'))!.password_hash).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
    assert.deepEqual(queue.status,{active:0,waiting:0});
  }finally{release();await Promise.all(blockers);await f.close();}
});
test('bounded direct/proxy identity parsing measurements',t=>{
  const direct=loadIngressConfig({INGRESS_MODE:'direct'}),trusted=cfg();
  const headers=['X-Forwarded-For',Array.from({length:16},(_,i)=>`2001:db8::${(i+1).toString(16)}`).join(',')];
  for(const [mode,config,peer,fields] of [['direct',direct,'::ffff:192.0.2.1',[]],['trusted-proxy',trusted,'127.0.0.2',headers]] as const){
    const start=performance.now();for(let i=0;i<10000;i++)config.resolve(peer,fields);
    t.diagnostic(JSON.stringify({mode,iterations:10000,totalMs:performance.now()-start}));
  }
});

test('registration, forgot, email-change and login stores use the same canonical client',async()=>{
  class SyntheticLogin extends PasswordService {
    override async verifyLogin(password:string,stored?:string){return !!stored&&password==='synthetic-password-123';}
  }
  const h=await securityHarness(true,true,new SyntheticLogin());
  const identity=(i:number)=>({'X-StudyPilot-Test-Client':i%2?'::ffff:198.51.100.20':'198.51.100.20'});
  try{
    const a=await h.register();
    for(let i=0;i<5;i++)assert.equal((await h.send('POST','/api/auth/register',{email:`invalid-${i}`,password:'synthetic-password-123'},undefined,identity(i))).status,i===4?429:400);
    const forgot=await h.send('POST','/api/auth/forgot',{email:a.email},undefined,identity(1));assert.equal(forgot.status,200);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(Number((await h.db.get("SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose='password_reset'"))!.count),0);
    const change=await h.send('PATCH','/api/auth/email',{newEmail:'changed@example.test',password:'synthetic-password-123'},a.cookie,identity(0));assert.equal(change.status,429);assert.ok(Number(change.headers.get('Retry-After'))>0);
    // Login keeps its separate existing store, but uses the same canonical IP.
    for(let i=0;i<5;i++)assert.equal((await h.send('POST','/api/auth/login',{email:a.email,password:'incorrect-synthetic'},undefined,identity(i))).status,i===4?429:401);
    assert.equal((await h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'},undefined,{'X-StudyPilot-Test-Client':'198.51.100.21'})).status,200);
    assert.equal((await h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'},undefined,identity(1))).status,429);
  }finally{await h.close();}
});
test('disabled verification resend canonicalizes IP while enabled resend retains user-based limits',async()=>{
  const disabled=await securityHarness(true,false);
  try{
    assert.equal((await disabled.send('POST','/api/auth/resend-verification',{},undefined,{'X-StudyPilot-Test-Client':'2001:db8::1'})).status,202);
    const limited=await disabled.send('POST','/api/auth/resend-verification',{},undefined,{'X-StudyPilot-Test-Client':'2001:0DB8:0:0:0:0:0:1'});assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('Retry-After'))>0);
  }finally{await disabled.close();}
  const enabled=await securityHarness(true,true);
  try{
    const a=await enabled.register();assert.equal((await enabled.send('POST','/api/auth/resend-verification',{},a.cookie)).status,202);
    assert.equal((await enabled.send('POST','/api/auth/resend-verification',{},a.cookie,{'X-StudyPilot-Test-Client':'198.51.100.2'})).status,429);
  }finally{await enabled.close();}
});
test('server rejects missing production ingress before any database startup',()=>{
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',DATABASE_URL:'synthetic-must-not-be-opened',DB_PATH:':memory:',MAIL_API_KEY:''};
  delete env.INGRESS_MODE;delete env.TRUSTED_PROXY_CIDRS;
  const child=spawnSync(process.execPath,['--import','tsx','src/server.ts'],{env,encoding:'utf8',timeout:10000});
  assert.notEqual(child.status,0);assert.ok(child.stderr.includes('INGRESS_MODE must be explicitly'));
});
