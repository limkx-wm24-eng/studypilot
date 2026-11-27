// Private stdin/stdout RPC for disposable Docker fixtures. The orchestrator
// captures responses in memory; cookies and record checksums are never logged.
import { randomBytes, randomUUID, scryptSync, scrypt, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openDb } from '/app/dist/db.js';

assert.equal(process.env.STUDYPILOT_ROLLBACK_FIXTURE,'1');
if(process.env.DATABASE_URL){const url=new URL(process.env.DATABASE_URL);assert.match(url.hostname,/^studypilot-rollback-[a-f0-9]+-pg$/);assert.match(url.pathname,/test/);}
else assert.equal(process.env.DB_PATH,'/data/studypilot.db');
let input='';for await(const chunk of process.stdin)input+=chunk;
const command=JSON.parse(input);let db;
try{
  let result;
  if(command.op==='request'){
    assert.ok(command.path.startsWith('/')&&!command.path.startsWith('//'));
    const response=await fetch(`http://127.0.0.1:3000${command.path}`,{method:command.method??'GET',headers:{...(command.data!==undefined?{'Content-Type':'application/json'}:{}),...(command.cookie?{Cookie:command.cookie}:{})},body:command.data===undefined?undefined:JSON.stringify(command.data)});
    const body=await response.text();let data;try{data=JSON.parse(body);}catch{data=body;}
    result={status:response.status,data,cookies:response.headers.getSetCookie()};
  }else{
    db=await openDb(process.env.DB_PATH,{migrationsThrough:command.op==='seed'?9:undefined});
    if(command.op==='seed'){
      const ids={};
      for(const [label,N,versioned] of [['legacy',16384,false],['rollback-legacy',16384,false],['rollback-older',8192,true]]){
        const salt=randomBytes(16),key=scryptSync('synthetic-recovery-123',salt,64,{N,r:8,p:1});
        const stored=versioned?`scrypt$v1$N=${N},r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`:`${salt.toString('hex')}:${key.toString('hex')}`;
        ids[label]=randomUUID();await db.run('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)',[ids[label],`${label}@example.test`,stored]);
      }
      const klass=randomUUID(),task=randomUUID(),slot=randomUUID(),course=randomUUID();
      await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)',[klass,ids.legacy,'x'.repeat(70),'#0f766e']);
      await db.run('INSERT INTO tasks(id,class_id,type,name,priority,status,due) VALUES(?,?,?,?,?,?,?)',[task,klass,'Homework','Synthetic legacy task','Medium','Not started','2026-11-02']);
      await db.run('INSERT INTO slots(id,class_id,kind,weekday,start_time,end_time) VALUES(?,?,?,?,?,?)',[slot,klass,'Lecture',1,'09:00','10:00']);
      await db.run('INSERT INTO attendance(slot_id,date,status) VALUES(?,?,?)',[slot,'2026-11-02','present']);
      await db.run('INSERT INTO courses(id,user_id,semester_label,course_name,credit_hours,grade) VALUES(?,?,?,?,?,?)',[course,ids.legacy,'Synthetic semester','Synthetic legacy course',3,'A']);
      result={klass,task,slot,course};
    }else if(command.op==='strong'){
      // Explicit future-writer fixture, never a production route/policy switch.
      const salt=randomBytes(16);
      const key=await new Promise((resolve,reject)=>scrypt('synthetic-recovery-123',salt,64,{N:16384,r:8,p:5,maxmem:34*1024*1024},(error,key)=>error?reject(error):resolve(key)));
      const stored=`scrypt$v1$N=16384,r=8,p=5$${salt.toString('hex')}$${key.toString('hex')}`;
      const updated=await db.run('UPDATE users SET password_hash=? WHERE email=?',[stored,command.email]);assert.equal(updated.changes,1);
      result={seeded:true};
    }else if(command.op==='snapshot'){
      const records={};for(const row of await db.all('SELECT email,password_hash FROM users ORDER BY email')){
        const value=String(row.password_hash),profile=value.startsWith('scrypt$v1$N=16384,r=8,p=5$')?'stronger':value.startsWith('scrypt$v1$N=16384,r=8,p=1$')?'current':value.startsWith('scrypt$v1$N=8192,r=8,p=1$')?'older':'legacy';
        records[row.email]={profile,checksum:createHash('sha256').update(value).digest('hex')};
      }
      const data={};for(const table of ['classes','tasks','slots','attendance','courses'])data[table]=await db.all(`SELECT * FROM ${table} ORDER BY 1`);
      result={records,dataChecksum:createHash('sha256').update(JSON.stringify(data)).digest('hex'),ledger:(await db.all('SELECT id FROM schema_migrations ORDER BY id')).map(row=>row.id)};
    }else if(command.op==='guards'){
      const owner=(await db.get('SELECT user_id FROM classes WHERE id=?',[command.klass])).user_id;
      let inserted=false,updated=false,orphaned=false;
      try{await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)',[randomUUID(),owner,'x'.repeat(61),'#0f766e']);inserted=true;}catch{}
      try{await db.run('UPDATE classes SET name=name WHERE id=?',[command.klass]);updated=true;}catch{}
      try{await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)',[randomUUID(),randomUUID(),'Synthetic orphan','#0f766e']);orphaned=true;}catch{}
      assert.equal(inserted,false);assert.equal(updated,false);assert.equal(orphaned,false);
      assert.equal(String((await db.get('SELECT name FROM classes WHERE id=?',[command.klass])).name).length,70);
      if(!process.env.DATABASE_URL){assert.equal((await db.get('PRAGMA foreign_keys')).foreign_keys,1);assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);}
      result={insertRejected:true,nameUpdateRejected:true,foreignKeys:true,legacyNamePreserved:true};
    }else throw new Error('Unsupported disposable fixture operation');
  }
  await db?.close();db=undefined;process.stdout.write(JSON.stringify(result));
}catch{process.stderr.write('Disposable recovery fixture failed; private response suppressed.\n');process.exitCode=1;}
finally{await db?.close();}
