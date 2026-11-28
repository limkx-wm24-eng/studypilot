import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,openSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const repo=fileURLToPath(new URL('../',import.meta.url));
const evidence=mkdtempSync(join(tmpdir(),'studypilot-ingress-'));
const name=`studypilot-ingress-${randomUUID().replaceAll('-','').slice(0,12)}`;
const support=resolve(repo,'test/support');let created=false;const results=[];const cleanupFailures=[];
const docker=args=>execFileSync('docker',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const stop=()=>{if(created){docker(['stop',name]);docker(['rm','-v',name]);created=false;}};
try{
  const identity=join(evidence,'image.id'),fd=openSync(join(evidence,'build.log'),'w');
  try{execFileSync('docker',['build','--iidfile',identity,'.'],{cwd:repo,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  const image=readFileSync(identity,'utf8').trim();writeFileSync(join(evidence,'images.json'),JSON.stringify({candidate:image},null,2));
  const invalid=spawnSync('docker',['run','--rm','--network','none','--env','NODE_ENV=production','--env','DATABASE_URL=synthetic-must-not-be-opened','--env','DB_PATH=:memory:','--env','MAIL_API_KEY=',image],{encoding:'utf8'});
  assert.notEqual(invalid.status,0);assert.ok(invalid.stderr.includes('INGRESS_MODE must be explicitly'));
  for(const mode of ['direct','trusted-proxy']){
    docker(['run','--detach','--name',name,'--network','none','--env','NODE_ENV=production','--env','DATABASE_URL=','--env','DB_PATH=:memory:','--env','PORT=3000','--env','MAIL_API_KEY=',`--env`,`INGRESS_MODE=${mode}`,'--env',`TRUSTED_PROXY_CIDRS=${mode==='direct'?'':'127.0.0.2/32'}`,'--mount',`type=bind,source=${support},target=/review,readonly`,image]);created=true;
    let ready=false;
    for(let i=0;i<100;i++){try{docker(['exec',name,'node','/review/ingressSmoke.mjs','--ready']);ready=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready,'Local ingress application did not become ready');
    const result=JSON.parse(docker(['exec',name,'node','/review/ingressSmoke.mjs']));assert.equal(result.status,'passed');results.push(result);console.log(JSON.stringify(result));stop();
  }
}catch{process.exitCode=1;console.error(`Local production ingress smoke failed; private responses suppressed. Evidence: ${evidence}`);}
finally{
  try{stop();}catch{process.exitCode=1;cleanupFailures.push(name);}
  writeFileSync(join(evidence,'results.json'),JSON.stringify({results,cleanupFailures},null,2));
  console.log(`Production ingress evidence: ${evidence}`);
}
