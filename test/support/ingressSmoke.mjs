import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {PASSWORD_POLICY,PASSWORD_MAXMEM,HASH_ACTIVE_LIMIT,HASH_QUEUE_LIMIT} from '/app/dist/passwords.js';

assert.equal(process.env.NODE_ENV,'production');assert.equal(process.env.DB_PATH,':memory:');assert.equal(process.env.DATABASE_URL??'','');
const mode=process.env.INGRESS_MODE;
const send=(port,path,body,headers={},source='127.0.0.1')=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,localAddress:source,path,method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers}},res=>{
    let text='';res.on('data',part=>{text+=part;});res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,headers:res.headers,data});});
  });req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();
});
const readyHeaders=mode==='trusted-proxy'?{'X-Forwarded-For':'192.0.2.1'}:{};
const readySource=mode==='trusted-proxy'?'127.0.0.2':'127.0.0.1';
if(process.argv.includes('--ready')){
  assert.equal((await send(3000,'/api/health',undefined,readyHeaders,readySource)).status,200);
  process.stdout.write(JSON.stringify({ready:true}));
}else{
  assert.deepEqual(PASSWORD_POLICY,{N:16384,r:8,p:5});assert.equal(PASSWORD_MAXMEM,34*1024*1024);assert.equal(HASH_ACTIVE_LIMIT,2);assert.equal(HASH_QUEUE_LIMIT,8);
  let proxy;let port=3000;
  try{
    if(mode==='trusted-proxy'){
      assert.equal((await send(3000,'/api/health',undefined,{'X-Forwarded-For':'192.0.2.1'})).status,403);
      assert.equal((await send(3000,'/api/health',undefined,{},'127.0.0.2')).status,400);
      const malformed=await send(3000,'/api/auth/login',{email:'synthetic@example.test',password:'synthetic-password-123'},{'X-Forwarded-For':'invalid'},'127.0.0.2');assert.equal(malformed.status,400);assert.equal(malformed.headers['cache-control'],'no-store');
      proxy=createServer((req,res)=>{
        const headers={...req.headers,'x-forwarded-for':[req.headers['x-forwarded-for'],req.socket.remoteAddress].filter(Boolean).join(', ')};
        const upstream=request({host:'127.0.0.1',port:3000,localAddress:'127.0.0.2',path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
        upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
      }).listen(0,'127.0.0.1');await new Promise(resolve=>proxy.once('listening',resolve));port=proxy.address().port;
    }
    assert.deepEqual((await send(port,'/api/config')).data,{emailEnabled:false});
    const denied=await send(port,'/api/auth/register',{email:'synthetic-denied@example.test',password:'synthetic-password-123'},{Origin:'https://foreign.example.test','X-Forwarded-Host':'foreign.example.test','X-Forwarded-Proto':'https'});assert.equal(denied.status,403);assert.equal(denied.headers['cache-control'],'no-store');
    for(let i=0;i<10;i++)assert.equal((await send(port,'/api/auth/reset',{}, {'X-Forwarded-For':`203.0.113.${i+1}`})).status,400);
    const limited=await send(port,'/api/auth/reset',{}, {'X-Forwarded-For':'198.51.100.1'});assert.equal(limited.status,429);assert.ok(Number(limited.headers['retry-after'])>0);assert.equal(limited.headers['cache-control'],'no-store');
    assert.equal((await send(port,'/api/auth/register',{email:'synthetic@example.test',password:'synthetic-password-123'})).status,201);
    const login=await send(port,'/api/auth/login',{email:'synthetic@example.test',password:'synthetic-password-123'});assert.equal(login.status,200);
    assert.ok(login.headers['set-cookie'].some(cookie=>/; Secure/i.test(cookie)&&/; HttpOnly/i.test(cookie)&&/; SameSite=Lax/i.test(cookie)));
    const cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal((await send(port,'/api/auth/me',undefined,{Cookie:cookie})).status,200);
    assert.equal((await send(port,'/api/health')).status,200);
    process.stdout.write(JSON.stringify({mode,status:'passed',boundary:true,spoofingBlocked:true,originProtected:true,cookieFlags:true,p5Authentication:true,mailDisabled:true,privateApiNoStore:true,healthResponsive:true}));
  }finally{if(proxy)await new Promise(resolve=>proxy.close(resolve));}
}
