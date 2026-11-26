import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROLLBACK_COMMIT='14614752e81f6e4d6a78f93210b9eb7c9c447939';
const OLD_MAIN='ac4f510258ffe95203d153d6eefd285b5ed77d3e';
const repo=fileURLToPath(new URL('../',import.meta.url));
const artifacts=mkdtempSync(join(tmpdir(),'studypilot-rollback-'));
const prefix=`studypilot-rollback-${randomUUID().replaceAll('-','').slice(0,12)}`;
const network=`${prefix}-network`,pg=`${prefix}-pg`,volume=`${prefix}-sqlite`,app=`${prefix}-app`;
const support=resolve(repo,'test/support');
let phase='build',networkCreated=false,pgCreated=false,volumeCreated=false,appCreated=false;
const results=[];
const docker=(args,options={})=>execFileSync('docker',args,{cwd:repo,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe'],...options}).trim();
const stopApp=()=>{if(appCreated){docker(['stop',app]);docker(['rm','-v',app]);appCreated=false;}};
const build=(role,commit)=>{
  let root=repo;
  if(commit){
    const resolved=execFileSync('git',['rev-parse',`${commit}^{commit}`],{cwd:repo,encoding:'utf8'}).trim();assert.equal(resolved,commit);
    const names=execFileSync('git',['ls-tree','-r','--name-only',commit],{cwd:repo,encoding:'utf8'});
    assert.ok(!names.split('\n').some(name=>/(^|\/)\.env(?:$|\.)/.test(name)&&!name.endsWith('.env.example')));
    root=join(artifacts,role);mkdirSync(root);
    const archive=join(artifacts,`${role}.tar`);execFileSync('git',['archive','--format=tar','--output',archive,commit],{cwd:repo});
    execFileSync('tar',['-xf',archive,'-C',root]);
  }
  const identity=join(artifacts,`${role}-image.id`),fd=openSync(join(artifacts,`${role}-build.log`),'w');
  try{execFileSync('docker',['build','--iidfile',identity,root],{cwd:repo,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  console.log(`Built ${role} image using its own manifests/lockfiles.`);
  return readFileSync(identity,'utf8').trim();
};
const settings=dialect=>{
  const url=new URL('postgresql://localhost');url.hostname=pg;url.username='studypilot';url.pathname='/studypilot_recovery_test';
  return {env:{...process.env,DATABASE_URL:dialect==='postgres'?url.toString():''},args:[
    '--network',dialect==='postgres'?network:'none','--env','DATABASE_URL','--env','NODE_ENV=production','--env','MAIL_API_KEY=','--env','MAIL_PROVIDER=brevo','--env','DB_PATH=/data/studypilot.db','--env','STUDYPILOT_ROLLBACK_FIXTURE=1',
    '--mount',`type=bind,source=${support},target=/review,readonly`,
    ...(dialect==='sqlite'?['--mount',`type=volume,source=${volume},target=/data`]:[]),
  ]};
};
const rpc=(command)=>JSON.parse(docker(['exec','-i',app,'node','/review/rollbackProbe.mjs'],{input:JSON.stringify(command)}));
const request=(path,method='GET',data,cookie)=>rpc({op:'request',path,method,data,cookie});
const snapshot=()=>rpc({op:'snapshot'});
const launch=async(image,dialect,hasConfig=true)=>{
  const config=settings(dialect);docker(['run','--detach','--name',app,...config.args,image],{env:config.env});appCreated=true;
  let ready=false;for(let i=0;i<100;i++){try{if(request('/api/health').status===200){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}assert.ok(ready,'Recovery application did not become ready');
  if(hasConfig)assert.deepEqual(request('/api/config').data,{emailEnabled:false});
};
const login=(email)=>{
  const response=request('/api/auth/login','POST',{email,password:'synthetic-recovery-123'});assert.equal(response.status,200,'Compatible recovery login failed');
  assert.ok(response.cookies.some(cookie=>/; Secure/i.test(cookie)&&/; HttpOnly/i.test(cookie)));
  return response.cookies[0].split(';')[0];
};
const intact=(before,after,email)=>assert.ok(before.records[email].checksum===after.records[email].checksum,'An existing current password record changed during recovery');
try{
  const candidate=build('candidate'),rollback=build('rollback',ROLLBACK_COMMIT),oldMain=build('old-main-negative',OLD_MAIN);
  writeFileSync(join(artifacts,'images.json'),JSON.stringify({candidate,rollback,rollbackCommit:ROLLBACK_COMMIT,oldMain,oldMainCommit:OLD_MAIN},null,2));
  docker(['network','create','--internal',network]);networkCreated=true;
  docker(['run','--detach','--name',pg,'--network',network,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB=studypilot_recovery_test','--env','POSTGRES_USER=studypilot','postgres:16-alpine']);pgCreated=true;
  let pgReady=false;for(let i=0;i<100;i++){try{docker(['exec',pg,'pg_isready','-U','studypilot','-d','studypilot_recovery_test']);pgReady=true;break;}catch{}await new Promise(done=>setTimeout(done,100));}assert.ok(pgReady);
  docker(['volume','create',volume]);volumeCreated=true;
  for(const dialect of ['sqlite','postgres']){
    phase=`${dialect}: seed genuine 009 fixture`;const config=settings(dialect);
    const fixture=JSON.parse(docker(['run','--rm','-i',...config.args,'--entrypoint','node',candidate,'/review/rollbackProbe.mjs'],{env:config.env,input:JSON.stringify({op:'seed'})}));
    phase=`${dialect}: corrected candidate`;await launch(candidate,dialect);
    const registered=request('/api/auth/register','POST',{email:'new@example.test',password:'synthetic-recovery-123'});assert.equal(registered.status,201);
    const newCookie=registered.cookies[0].split(';')[0],legacyCookie=login('legacy@example.test');
    assert.equal(request('/api/auth/me','PATCH',{courseType:'Degree',semesterStart:'2026-11-02',semesterWeeks:7},legacyCookie).status,200);
    const klass=request('/api/classes','POST',{name:'Synthetic new class',color:'#112233'},newCookie);assert.equal(klass.status,201);
    const task=request('/api/tasks','POST',{classId:klass.data.id,name:'Synthetic new task',type:'Homework',priority:'Medium',status:'Not started',due:'2026-11-02',grade:70},newCookie);assert.equal(task.status,201);
    const slot=request('/api/slots','POST',{classId:klass.data.id,kind:'Lecture',weekday:1,start:'09:00',end:'10:00',room:'Synthetic'},newCookie);assert.equal(slot.status,201);
    assert.equal(request('/api/attendance','PUT',{slotId:slot.data.id,date:'2026-11-02',status:'present'},newCookie).status,200);
    const course=request('/api/courses','POST',{semesterLabel:'Synthetic semester',courseName:'Synthetic course',creditHours:3,grade:'A'},newCookie);assert.equal(course.status,201);
    rpc({op:'guards',klass:fixture.klass});const before=snapshot();assert.equal(before.ledger.length,11);
    assert.equal(before.records['new@example.test'].profile,'current');assert.equal(before.records['legacy@example.test'].profile,'current');
    assert.equal(before.records['rollback-legacy@example.test'].profile,'legacy');assert.equal(before.records['rollback-older@example.test'].profile,'older');stopApp();
    // The selected historical runner is used only after verified, complete
    // migrations, with no concurrent startup or migration in progress.
    phase=`${dialect}: selected immutable rollback`;await launch(rollback,dialect);
    const started=snapshot();assert.equal(started.dataChecksum,before.dataChecksum);assert.deepEqual(started.ledger,before.ledger);
    assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,200,'Existing session did not survive handoff');
    for(const email of ['new@example.test','legacy@example.test','rollback-legacy@example.test','rollback-older@example.test'])login(email);
    const afterLogin=snapshot();intact(before,afterLogin,'new@example.test');intact(before,afterLogin,'legacy@example.test');
    for(const record of Object.values(afterLogin.records))assert.equal(record.profile,'current');
    assert.equal(request('/api/auth/login','POST',{email:'new@example.test',password:'incorrect-synthetic'}).status,401);
    const newAgain=login('new@example.test');
    assert.equal(request(`/api/tasks/${fixture.task}`,'PATCH',{grade:99},newAgain).status,404);
    assert.ok(!request('/api/classes','GET',undefined,newAgain).data.some(row=>row.id===fixture.klass));
    assert.equal(request(`/api/classes/${fixture.klass}`,'PATCH',{color:'#445566'},legacyCookie).status,200);
    assert.equal(request(`/api/classes/${fixture.klass}`,'PATCH',{name:'x'.repeat(61)},legacyCookie).status,400);
    assert.equal(request(`/api/tasks/${task.data.id}`,'PATCH',{grade:91,status:'Complete'},newAgain).status,200);
    assert.equal(request(`/api/courses/${course.data.id}`,'PATCH',{grade:'B+'},newAgain).status,200);
    assert.equal(request('/api/attendance/summary','GET',undefined,legacyCookie).status,200);
    assert.equal(request('/api/auth/logout','POST',undefined,newAgain).status,204);
    assert.equal(request('/api/auth/me','GET',undefined,newAgain).status,401);
    rpc({op:'guards',klass:fixture.klass});const recovered=snapshot();stopApp();
    phase=`${dialect}: old-main negative evidence`;await launch(oldMain,dialect,false);
    assert.equal(request('/api/auth/login','POST',{email:'new@example.test',password:'synthetic-recovery-123'}).status,500,'Old-main incompatibility must remain explicit');stopApp();
    phase=`${dialect}: corrected candidate restart`;await launch(candidate,dialect);
    const finalCookie=login('new@example.test');login('legacy@example.test');login('rollback-legacy@example.test');login('rollback-older@example.test');
    assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,200);
    const final=snapshot();assert.equal(final.dataChecksum,recovered.dataChecksum);assert.deepEqual(final.ledger,recovered.ledger);
    for(const email of Object.keys(final.records))intact(recovered,final,email);
    assert.equal(request('/api/tasks','GET',undefined,finalCookie).data.find(row=>row.id===task.data.id).grade,91);
    rpc({op:'guards',klass:fixture.klass});stopApp();
    const result={dialect,status:'passed',legacyAndOlderProfilesUpgraded:true,currentRecordsUnchanged:true,sessionsAndOwnership:true,studyDataReadWrite:true,guardsAndForeignKeys:true,oldMainNegativeStatus:500,candidateRollbackCandidate:true,serializedCompletedMigrationsRequired:true};
    results.push(result);console.log(JSON.stringify(result));
  }
  console.log(`Recovery evidence: ${artifacts}`);
}catch{
  process.exitCode=1;console.error(`Recovery verification failed during ${phase}. Private RPC responses suppressed. Evidence: ${artifacts}`);
}finally{
  const cleanupFailures=[];
  try{stopApp();}catch{cleanupFailures.push(app);}
  if(pgCreated){try{docker(['stop',pg]);docker(['rm','-v',pg]);}catch{cleanupFailures.push(pg);}}
  if(volumeCreated){try{docker(['volume','rm',volume]);}catch{cleanupFailures.push(volume);}}
  if(networkCreated){try{docker(['network','rm',network]);}catch{cleanupFailures.push(network);}}
  if(cleanupFailures.length){process.exitCode=1;console.error('Disposable recovery cleanup incomplete.');}
  writeFileSync(join(artifacts,'results.json'),JSON.stringify({rollbackCommit:ROLLBACK_COMMIT,results,cleanupFailures},null,2));
}
