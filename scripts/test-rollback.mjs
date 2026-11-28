import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROLLBACK_COMMIT='3eb77b75297cd7b9cd7717d459e83b59af8858fb';
const HISTORICAL_ROLLBACK_COMMIT='14614752e81f6e4d6a78f93210b9eb7c9c447939';
const OLD_MAIN='ac4f510258ffe95203d153d6eefd285b5ed77d3e';
const repo=fileURLToPath(new URL('../',import.meta.url));
const artifacts=mkdtempSync(join(tmpdir(),'studypilot-rollback-'));
const prefix=`studypilot-rollback-${randomUUID().replaceAll('-','').slice(0,12)}`;
const network=`${prefix}-network`,pg=`${prefix}-pg`,volume=`${prefix}-sqlite`,app=`${prefix}-app`;
const writerVolume=`${prefix}-writer-sqlite`;
const support=resolve(repo,'test/support');
let phase='build',networkCreated=false,pgCreated=false,volumeCreated=false,writerVolumeCreated=false,appCreated=false;
let activeScenario='historical';
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
  const url=new URL('postgresql://localhost');url.hostname=pg;url.username='studypilot';url.pathname=activeScenario==='historical'?'/studypilot_recovery_test':'/studypilot_writer_recovery_test';
  return {env:{...process.env,DATABASE_URL:dialect==='postgres'?url.toString():''},args:[
    '--network',dialect==='postgres'?network:'none','--env','DATABASE_URL','--env','NODE_ENV=production','--env','MAIL_API_KEY=','--env','MAIL_PROVIDER=brevo','--env','DB_PATH=/data/studypilot.db','--env','STUDYPILOT_ROLLBACK_FIXTURE=1',
    '--mount',`type=bind,source=${support},target=/review,readonly`,
    ...(dialect==='sqlite'?['--mount',`type=volume,source=${activeScenario==='historical'?volume:writerVolume},target=/data`]:[]),
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
const reset=(email,cookie)=>{
  const {token}=rpc({op:'reset-token',email});
  const response=request('/api/auth/reset','POST',{token,newPassword:'synthetic-recovery-123'});assert.equal(response.status,200);
  assert.equal(request('/api/auth/reset','POST',{token,newPassword:'synthetic-recovery-123'}).status,400);
  if(cookie)assert.equal(request('/api/auth/me','GET',undefined,cookie).status,401);
};
const actualHandoff=async(dialect,writer,p1a,obsolete)=>{
  phase=`${dialect}: actual writer seed`;const config=settings(dialect);
  const fixture=JSON.parse(docker(['run','--rm','-i',...config.args,'--entrypoint','node',writer,'/review/rollbackProbe.mjs'],{env:config.env,input:JSON.stringify({op:'seed',writerScenario:true})}));
  await launch(writer,dialect);
  const registered=request('/api/auth/register','POST',{email:'new@example.test',password:'synthetic-recovery-123'});assert.equal(registered.status,201);
  let newCookie=registered.cookies[0].split(';')[0];
  const upgraded=['legacy@example.test','rollback-legacy@example.test','rollback-older@example.test','writer-current@example.test'];
  const legacyCookie=login(upgraded[0]);for(const email of upgraded.slice(1))login(email);
  const classResponse=request('/api/classes','POST',{name:'Synthetic writer class',color:'#112233'},newCookie);assert.equal(classResponse.status,201);
  const klass=classResponse.data;
  const task=request('/api/tasks','POST',{classId:klass.id,name:'Synthetic writer task',type:'Homework',priority:'Medium',status:'Not started',due:'2026-11-02',grade:70},newCookie);assert.equal(task.status,201);
  const slot=request('/api/slots','POST',{classId:klass.id,kind:'Lecture',weekday:1,start:'09:00',end:'10:00',room:'Synthetic'},newCookie);assert.equal(slot.status,201);
  assert.equal(request('/api/attendance','PUT',{slotId:slot.data.id,date:'2026-11-02',status:'present'},newCookie).status,200);
  const course=request('/api/courses','POST',{semesterLabel:'Synthetic semester',courseName:'Synthetic writer course',creditHours:3,grade:'A'},newCookie);assert.equal(course.status,201);
  const preReset=snapshot();assert.equal(preReset.records['new@example.test'].profile,'stronger','Actual registration must write p=5 before reset');
  reset('new@example.test',newCookie);newCookie=login('new@example.test');
  const before=snapshot();assert.ok(before.records['new@example.test'].checksum!==preReset.records['new@example.test'].checksum);
  for(const email of ['new@example.test',...upgraded])assert.equal(before.records[email].profile,'stronger');
  assert.equal(before.records['dormant@example.test'].profile,'older');assert.equal(before.ledger.length,11);
  rpc({op:'guards',klass:fixture.klass});
  const strongRecord=rpc({op:'record',email:'new@example.test'}).stored;
  // Never attach a p=5 database to the obsolete application: this process only
  // evaluates its immutable reader with one private stdin record, network off.
  const negative=JSON.parse(docker(['run','--rm','-i','--network','none','--env','DATABASE_URL=','--env','DB_PATH=/data/studypilot.db','--env','STUDYPILOT_ROLLBACK_FIXTURE=1','--mount',`type=bind,source=${support},target=/review,readonly`,'--entrypoint','node',obsolete,'/review/rollbackProbe.mjs'],{input:JSON.stringify({op:'reader',stored:strongRecord})}));
  assert.equal(negative.verified,false);stopApp();
  phase=`${dialect}: immutable P1-A recovery`;await launch(p1a,dialect);
  const started=snapshot();assert.equal(started.dataChecksum,before.dataChecksum);assert.deepEqual(started.ledger,before.ledger);
  assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,200);assert.equal(request('/api/auth/me','GET',undefined,legacyCookie).status,200);
  for(const email of ['new@example.test',...upgraded])login(email);
  const afterLogin=snapshot();for(const email of ['new@example.test',...upgraded])intact(before,afterLogin,email);
  const incorrect=request('/api/auth/login','POST',{email:'new@example.test',password:'incorrect-synthetic'});assert.equal(incorrect.status,401);assert.equal(incorrect.cookies.length,0);
  intact(afterLogin,snapshot(),'new@example.test');
  reset('new@example.test',newCookie);newCookie=login('new@example.test');
  const strongReset=snapshot();assert.equal(strongReset.records['new@example.test'].profile,'stronger');assert.ok(strongReset.records['new@example.test'].checksum!==afterLogin.records['new@example.test'].checksum);
  assert.equal(request(`/api/tasks/${fixture.task}`,'PATCH',{grade:99},newCookie).status,404);
  assert.equal(request(`/api/classes/${fixture.klass}`,'PATCH',{color:'#445566'},legacyCookie).status,200);
  assert.equal(request(`/api/tasks/${task.data.id}`,'PATCH',{grade:91,status:'Complete'},newCookie).status,200);
  assert.equal(request(`/api/courses/${course.data.id}`,'PATCH',{grade:'B+'},newCookie).status,200);
  assert.equal(request('/api/attendance/summary','GET',undefined,newCookie).status,200);
  // Explicitly demonstrate the recovery writer limitation; these are isolated
  // fixtures, not an operational authorization to accept weaker production writes.
  assert.equal(request('/api/auth/register','POST',{email:'recovery-new@example.test',password:'synthetic-recovery-123'}).status,201);
  reset('recovery-weak@example.test');
  const recovered=snapshot();for(const email of ['recovery-new@example.test','recovery-weak@example.test'])assert.equal(recovered.records[email].profile,'current');
  assert.equal(recovered.records['dormant@example.test'].profile,'older');rpc({op:'guards',klass:fixture.klass});stopApp();
  phase=`${dialect}: actual writer resumed`;await launch(writer,dialect);
  const restarted=snapshot();assert.equal(restarted.dataChecksum,recovered.dataChecksum);assert.deepEqual(restarted.ledger,recovered.ledger);
  assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,200);assert.equal(request('/api/auth/me','GET',undefined,legacyCookie).status,200);
  for(const email of ['new@example.test',...upgraded])login(email);
  const retained=snapshot();for(const email of ['new@example.test',...upgraded])intact(recovered,retained,email);
  for(const email of ['recovery-new@example.test','recovery-weak@example.test','dormant@example.test'])login(email);
  const final=snapshot();for(const row of Object.values(final.records))assert.equal(row.profile,'stronger');
  assert.equal(final.dataChecksum,recovered.dataChecksum);assert.deepEqual(final.ledger,recovered.ledger);
  assert.equal(request('/api/tasks','GET',undefined,newCookie).data.find(row=>row.id===task.data.id).grade,91);
  rpc({op:'guards',klass:fixture.klass});assert.equal(request('/api/auth/logout','POST',undefined,newCookie).status,204);assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,401);stopApp();
  const result={scenario:'p1b-p1a-p1b',dialect,status:'passed',actualApiStrongWrites:true,weakerApiUpgrades:true,strongResetBothApplications:true,sessionsAndOwnership:true,studyDataReadWrite:true,guardsAndForeignKeys:true,migrationHistoryPreserved:true,strongRecordsUnchanged:true,recoveryWeakWritesDemonstrated:true,recoveryWeakRecordsUpgradedOnResume:true,dormantRecordNotBulkRewritten:true,obsoleteReaderRejectedStrongRecord:true};
  results.push(result);console.log(JSON.stringify(result));
};
try{
  const writer=build('candidate'),candidate=build('p1a',ROLLBACK_COMMIT),rollback=build('stage3-rollback',HISTORICAL_ROLLBACK_COMMIT),oldMain=build('old-main-negative',OLD_MAIN);
  writeFileSync(join(artifacts,'images.json'),JSON.stringify({candidate:writer,p1a:candidate,rollbackCommit:ROLLBACK_COMMIT,historicalRollback:rollback,historicalRollbackCommit:HISTORICAL_ROLLBACK_COMMIT,oldMain,oldMainCommit:OLD_MAIN},null,2));
  phase='isolated database provisioning';
  docker(['network','create','--internal',network]);networkCreated=true;
  docker(['run','--detach','--name',pg,'--network',network,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB=studypilot_recovery_test','--env','POSTGRES_USER=studypilot','postgres:16-alpine']);pgCreated=true;
  // The bootstrap server listens only on a Unix socket. Wait for the final TCP
  // server before provisioning the second, isolated scenario database.
  let pgReady=false;for(let i=0;i<100;i++){try{docker(['exec',pg,'pg_isready','-h','127.0.0.1','-U','studypilot','-d','studypilot_recovery_test']);pgReady=true;break;}catch{}await new Promise(done=>setTimeout(done,100));}assert.ok(pgReady);
  docker(['volume','create',volume]);volumeCreated=true;
  docker(['volume','create',writerVolume]);writerVolumeCreated=true;
  docker(['exec',pg,'createdb','-h','127.0.0.1','-U','studypilot','studypilot_writer_recovery_test']);
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
    rpc({op:'guards',klass:fixture.klass});
    // Preserve the complete original R-04 handoff above. Separately model a
    // future stronger writer with a fixture, then start this reader checkpoint.
    phase=`${dialect}: reader-compatible stronger fixture recovery`;
    rpc({op:'strong',email:'new@example.test'});const future=snapshot();
    assert.equal(future.records['new@example.test'].profile,'stronger');stopApp();
    await launch(candidate,dialect);const strongCookie=login('new@example.test');
    const compatible=snapshot();intact(future,compatible,'new@example.test');
    assert.equal(compatible.dataChecksum,future.dataChecksum);assert.deepEqual(compatible.ledger,future.ledger);
    assert.equal(request('/api/auth/me','GET',undefined,newCookie).status,200);
    assert.equal(request(`/api/tasks/${fixture.task}`,'PATCH',{grade:99},strongCookie).status,404);
    assert.equal(request(`/api/tasks/${task.data.id}`,'PATCH',{grade:92},strongCookie).status,200);
    assert.equal(request('/api/attendance/summary','GET',undefined,strongCookie).status,200);
    rpc({op:'guards',klass:fixture.klass});stopApp();
    const result={scenario:'historical-r04',dialect,status:'passed',legacyAndOlderProfilesUpgraded:true,currentRecordsUnchanged:true,sessionsAndOwnership:true,studyDataReadWrite:true,guardsAndForeignKeys:true,oldMainNegativeStatus:500,candidateRollbackCandidate:true,serializedCompletedMigrationsRequired:true,strongerReaderRecovery:true,strongerAutomaticDowngrade:false};
    results.push(result);console.log(JSON.stringify(result));
  }
  activeScenario='writer';for(const dialect of ['sqlite','postgres'])await actualHandoff(dialect,writer,candidate,rollback);
  console.log(`Recovery evidence: ${artifacts}`);
}catch{
  process.exitCode=1;console.error(`Recovery verification failed during ${phase}. Private RPC responses suppressed. Evidence: ${artifacts}`);
}finally{
  const cleanupFailures=[];
  try{stopApp();}catch{cleanupFailures.push(app);}
  if(pgCreated){try{docker(['stop',pg]);docker(['rm','-v',pg]);}catch{cleanupFailures.push(pg);}}
  if(volumeCreated){try{docker(['volume','rm',volume]);}catch{cleanupFailures.push(volume);}}
  if(writerVolumeCreated){try{docker(['volume','rm',writerVolume]);}catch{cleanupFailures.push(writerVolume);}}
  if(networkCreated){try{docker(['network','rm',network]);}catch{cleanupFailures.push(network);}}
  if(cleanupFailures.length){process.exitCode=1;console.error('Disposable recovery cleanup incomplete.');}
  writeFileSync(join(artifacts,'results.json'),JSON.stringify({rollbackCommit:ROLLBACK_COMMIT,results,cleanupFailures},null,2));
}
