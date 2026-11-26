import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { migrate, openDb, type Database } from '../src/db.js';
import { openTestDb, openTestPeer, testDialect } from './support/database.ts';

const source010 = await readFile(new URL('../migrations/010_class_name_limit.sqlite.sql', import.meta.url), 'utf8');
const repair = await readFile(new URL('../migrations/012_class_name_guard_repair.sqlite.sql', import.meta.url), 'utf8');
const normalized = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const wrap = (db: Database, decorate: (tx: Database) => Database): Database => ({
  all: db.all.bind(db), get: db.get.bind(db), run: db.run.bind(db), exec: db.exec.bind(db),
  transaction: operation => db.transaction(tx => operation(decorate(tx))), close: async () => {},
});
const snapshot = async (db: Database) => JSON.stringify({
  users: await db.all('SELECT id,email,name FROM users ORDER BY id'),
  classes: await db.all('SELECT * FROM classes ORDER BY id'), tasks: await db.all('SELECT * FROM tasks ORDER BY id'),
  slots: await db.all('SELECT * FROM slots ORDER BY id'), attendance: await db.all('SELECT * FROM attendance ORDER BY slot_id,date'),
  courses: await db.all('SELECT * FROM courses ORDER BY id'),
});
async function seed(db: Database) {
  const user = randomUUID(), klass = randomUUID(), slot = randomUUID();
  await db.run('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)', [user, `${user}@example.test`, 'synthetic-unused']);
  await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [klass,user,'x'.repeat(70),'#0f766e']);
  await db.run('INSERT INTO tasks(id,class_id,type,name,priority,status,due) VALUES(?,?,?,?,?,?,?)', [randomUUID(),klass,'Homework','Synthetic migration task','Medium','Not started','2026-11-02']);
  await db.run('INSERT INTO slots(id,class_id,kind,weekday,start_time,end_time) VALUES(?,?,?,?,?,?)', [slot,klass,'Lecture',1,'09:00','10:00']);
  await db.run('INSERT INTO attendance(slot_id,date,status) VALUES(?,?,?)', [slot,'2026-11-02','present']);
  await db.run('INSERT INTO courses(id,user_id,semester_label,course_name,credit_hours,grade) VALUES(?,?,?,?,?,?)', [randomUUID(),user,'Synthetic semester','Synthetic course',3,'A']);
  return { user, klass };
}
async function guards(db: Database, ids: { user: string; klass: string }) {
  for (const value of ['', ' ', 'x'.repeat(61), '🧪'.repeat(61)]) {
    await assert.rejects(db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [randomUUID(),ids.user,value,'#0f766e']));
    await assert.rejects(db.run('UPDATE classes SET name=? WHERE id=?', [value,ids.klass]));
  }
  await assert.rejects(db.run('UPDATE classes SET name=name WHERE id=?',[ids.klass]));
  await db.run('UPDATE classes SET color=? WHERE id=?',['#112233',ids.klass]);
  assert.equal((await db.get('SELECT name FROM classes WHERE id=?',[ids.klass]))!.name,'x'.repeat(70));
  for (const value of ['A','x'.repeat(60),'🧪'.repeat(60),'\t','\u00a0']) {
    await db.run('UPDATE classes SET name=? WHERE id=?',[value,ids.klass]);
    assert.equal((await db.get('SELECT name FROM classes WHERE id=?',[ids.klass]))!.name,value);
  }
  await assert.rejects(db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)',[randomUUID(),randomUUID(),'Valid','#112233']));
  if(testDialect==='sqlite') {
    for(const definition of repair.matchAll(/CREATE TRIGGER ([a-z_]+)[\s\S]+?END;/g)) {
      const actual=await db.get("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?",[definition[1]]);
      assert.equal(actual!.tbl_name,'classes');assert.equal(normalized(String(actual!.sql)),normalized(definition[0]));
    }
    assert.equal((await db.get('PRAGMA foreign_keys'))!.foreign_keys,1);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
  }
}

if(testDialect==='sqlite') {
  for(const missing of ['insert','update','both','none','incorrect-definition']) test(`R-02 recorded 010: forward repair with ${missing} guards`,async()=>{
    const db=await openTestDb(9);try{
      const ids=await seed(db);await migrate(db,'sqlite',10);
      if(['insert','both'].includes(missing))await db.exec('DROP TRIGGER classes_name_insert_limit');
      if(['update','both','incorrect-definition'].includes(missing))await db.exec('DROP TRIGGER classes_name_update_limit');
      if(missing==='incorrect-definition')await db.exec('CREATE TRIGGER classes_name_update_limit BEFORE UPDATE OF name ON classes BEGIN SELECT 1; END;');
      const before=await snapshot(db);await migrate(db,'sqlite');assert.equal(await snapshot(db),before);
      const ledger=await db.all('SELECT * FROM schema_migrations ORDER BY id');assert.equal(ledger.length,11);
      await migrate(db,'sqlite');assert.deepEqual(await db.all('SELECT * FROM schema_migrations ORDER BY id'),ledger);
      await db.transaction(tx=>tx.exec(repair));assert.equal(await snapshot(db),before);
      await guards(db,ids);
    }finally{await db.close();}
  });
  test('R-02 genuine disk restart recovers canonical partial unrecorded 010 and preserves populated data',async()=>{
    const path=join(await mkdtemp(join(tmpdir(),'studypilot-migration-restart-')),'synthetic.sqlite');
    let db=await openDb(path,{databaseUrl:'',migrationsThrough:9});
    const ids=await seed(db),before=await snapshot(db);
    await db.exec(source010.slice(0,source010.indexOf('CREATE TRIGGER classes_name_update_limit')));await db.close();
    db=await openDb(path,{databaseUrl:''});try{assert.equal(await snapshot(db),before);await guards(db,ids);}finally{await db.close();}
  });
  test('R-02 unrecorded 010 with both canonical guards can recover without suppressing errors',async()=>{
    const db=await openTestDb(9);try{
      const ids=await seed(db);await migrate(db,'sqlite',10);await db.run('DELETE FROM schema_migrations WHERE id=?',['010_class_name_limit.sqlite.sql']);
      const before=await snapshot(db);await migrate(db,'sqlite');assert.equal(await snapshot(db),before);await guards(db,ids);
    }finally{await db.close();}
  });
  test('R-02 interrupted repair restores its prior trigger state and retries safely',async()=>{
    const db=await openTestDb(9);try{
      const ids=await seed(db);await migrate(db,'sqlite',10);await db.exec('DROP TRIGGER classes_name_update_limit');
      const before=await db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name");
      const broken=wrap(db,tx=>({...tx,exec:async sql=>{if(sql===repair){await tx.exec('DROP TRIGGER classes_name_insert_limit');throw new Error('Synthetic repair interruption');}await tx.exec(sql);}}));
      await assert.rejects(migrate(broken,'sqlite'),/Synthetic repair/);
      assert.deepEqual(await db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"),before);
      assert.equal(await db.get('SELECT id FROM schema_migrations WHERE id=?',['012_class_name_guard_repair.sqlite.sql']),undefined);
      await migrate(db,'sqlite');await guards(db,ids);
    }finally{await db.close();}
  });
  for(const phase of ['between-statements','before-history','repair-before-history'])test(`R-02 atomic rollback and retry: ${phase}`,async()=>{
    const through=phase==='repair-before-history'?10:9,db=await openTestDb(9);try{
      const ids=await seed(db);if(through===10)await migrate(db,'sqlite',10);
      const before=await snapshot(db),ledger=await db.all('SELECT * FROM schema_migrations ORDER BY id');
      const broken=wrap(db,tx=>({...tx,
        exec:async sql=>{if(phase==='between-statements'&&sql===source010){await tx.exec(sql.slice(0,sql.indexOf('CREATE TRIGGER classes_name_update_limit')));throw new Error('Synthetic statement interruption');}await tx.exec(sql);},
        run:async(sql,args=[])=>{if(sql.startsWith('INSERT INTO schema_migrations')&&String(args[0]).startsWith(phase==='repair-before-history'?'012_':'010_')&&phase!=='between-statements')throw new Error('Synthetic history interruption');return tx.run(sql,args);},
      }));
      await assert.rejects(migrate(broken,'sqlite'),/Synthetic/);assert.equal(await snapshot(db),before);
      assert.deepEqual(await db.all('SELECT * FROM schema_migrations ORDER BY id'),ledger);
      assert.equal((await db.all("SELECT name FROM sqlite_master WHERE type='trigger'")).length,through===10?2:0);
      await migrate(db,'sqlite');await guards(db,ids);
    }finally{await db.close();}
  });
  for(const file of ['002_users_semester_weeks.sql','003_users_semester_start.sql','004_classes_created_at.sql','005_tasks_created_at.sql','006_users_reminder_days.sql','009_users_email_verified_at.sql'])test(`R-02 verified historical column without ledger: ${file}`,async()=>{
    const db=await openTestDb(9);try{await seed(db);const before=await snapshot(db);await db.run('DELETE FROM schema_migrations WHERE id=?',[file]);await migrate(db,'sqlite');assert.equal(await snapshot(db),before);assert.ok(await db.get('SELECT id FROM schema_migrations WHERE id=?',[file]));}finally{await db.close();}
  });
  test('R-02 rejects mismatched historical columns and unrelated duplicate errors without recording success',async()=>{
    const db=await openTestDb(1);try{
      await db.exec("ALTER TABLE users ADD COLUMN semester_weeks TEXT DEFAULT '14'");
      await assert.rejects(migrate(db,'sqlite'),/does not match/);
      assert.equal((await db.all('SELECT id FROM schema_migrations')).length,1);
    }finally{await db.close();}
    const other=await openTestDb(9);try{
      const broken=wrap(other,tx=>({...tx,exec:async sql=>{if(sql===source010)throw new Error('unrelated trigger already exists');await tx.exec(sql);}}));
      await assert.rejects(migrate(broken,'sqlite'),/unrelated trigger/);
      assert.equal((await other.all('SELECT id FROM schema_migrations')).length,9);
      await other.exec('CREATE TRIGGER classes_name_insert_limit BEFORE INSERT ON classes BEGIN SELECT 1; END;');
      await assert.rejects(migrate(other,'sqlite'),/Unexpected definition/);
      assert.equal((await other.all('SELECT id FROM schema_migrations')).length,9);
    }finally{await other.close();}
  });
  test('R-02 SQLite startup yields while another connection holds the migration transaction',async()=>{
    const path=join(await mkdtemp(join(tmpdir(),'studypilot-migration-concurrent-')),'synthetic.sqlite');
    const first=await openDb(path,{databaseUrl:'',migrationsThrough:9}),second=await openDb(path,{databaseUrl:'',migrationsThrough:9});
    const ids=await seed(first),before=await snapshot(first),entered=barrier(),attempted=barrier(),release=barrier();let busy=0;
    const held=wrap(first,tx=>({...tx,exec:async sql=>{if(sql===source010){entered.resolve();await release.promise;}await tx.exec(sql);}}));
    const pending=migrate(held,'sqlite');await entered.promise;let competing=Promise.resolve();
    try{
      const peer={...wrap(second,tx=>tx),transaction:async<T>(operation:(tx:Database)=>Promise<T>)=>{
        attempted.resolve();
        try{return await second.transaction(operation);}catch(error){if(typeof error==='object'&&error!==null&&'errcode' in error&&[5,6].includes(Number(error.errcode)))busy++;throw error;}
      }};
      competing=migrate(peer,'sqlite');await attempted.promise;release.resolve();
      await Promise.all([pending,competing]);assert.ok(busy>0,'A separate connection must actually contend before the holder is released');assert.equal(await snapshot(second),before);
      await first.transaction(tx=>migrate(tx,'sqlite'));await guards(second,ids);
    }finally{release.resolve();await Promise.allSettled([pending,competing]);await second.close();await first.close();}
  });
}

if(testDialect==='postgres') {
  for(const state of ['fresh','populated-010'])test(`R-03 separate pools serialize ${state} initialization and execute pending DDL once`,async()=>{
    const db=await openTestDb(state==='fresh'?0:9);let peer:Database|undefined;
    try{
      const ids=state==='fresh'?undefined:await seed(db);if(ids)await migrate(db,'postgres',10);
      peer=await openTestPeer(db);if(state==='fresh')await db.exec('DROP TABLE schema_migrations');
      const before=ids?await snapshot(db):undefined,ready=barrier();let arrivals=0,ddl=0;const pids=new Set();
      const observe=(connection:Database)=>wrap(connection,tx=>({...tx,get:async(sql,args=[])=>{
        if(sql.includes('pg_advisory_xact_lock')){pids.add((await tx.get('SELECT pg_backend_pid() AS pid'))!.pid);if(++arrivals===2)ready.resolve();await ready.promise;}return tx.get(sql,args);
      },exec:async sql=>{if(sql.includes(state==='fresh'?'CREATE TABLE IF NOT EXISTS users':'DO $migration$'))ddl++;await tx.exec(sql);}}));
      await Promise.all([migrate(observe(db),'postgres'),migrate(observe(peer),'postgres')]);
      assert.equal(pids.size,2);assert.equal(arrivals,2);assert.equal(ddl,1);
      if(before!==undefined)assert.equal(await snapshot(db),before);
      else for(const table of ['users','classes','tasks','slots','attendance','courses'])assert.deepEqual(await db.all(`SELECT * FROM ${table}`),[]);
      const ledger=await db.all('SELECT id FROM schema_migrations');assert.equal(ledger.length,11);assert.equal(new Set(ledger.map(row=>row.id)).size,11);
      if(ids)await guards(db,ids);
    }finally{await peer?.close();await db.close();}
  });
  test('R-03 independent processes concurrently open a fresh isolated schema',async()=>{
    const db=await openTestDb(0),children:ReturnType<typeof fork>[]=[];try{
      const schema=String((await db.get('SELECT current_schema() AS name'))!.name);await db.exec('DROP TABLE schema_migrations');
      const spawn=()=>{
        const child=fork(new URL('./support/migrationStartupWorker.mjs',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:'',STUDYPILOT_TEST_SCHEMA:schema},stdio:['ignore','ignore','ignore','ipc']});children.push(child);
        const ready=barrier();const started=new Promise<{pid:number;entries:number}>((resolve,reject)=>{
          const timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic startup worker timed out'));},20000);
          child.on('message',(message:any)=>{if(message.phase==='ready')ready.resolve();if(message.phase==='started'){clearTimeout(timer);resolve(message);}if(message.phase==='error'){clearTimeout(timer);reject(new Error(`Synthetic startup worker failed (${message.code})`));}});
          child.on('error',()=>{clearTimeout(timer);reject(new Error('Could not start synthetic migration worker'));});
        });return{child,ready:ready.promise,started};
      };
      const a=spawn(),b=spawn();await Promise.race([Promise.all([a.ready,b.ready]),Promise.all([a.started,b.started])]);a.child.send('go');b.child.send('go');
      const outcomes=await Promise.all([a.started,b.started]);assert.notEqual(outcomes[0].pid,outcomes[1].pid);assert.deepEqual(outcomes.map(x=>x.entries),[11,11]);
      await Promise.all(children.map(child=>new Promise<void>(done=>{if(child.exitCode!==null)done();else child.once('exit',()=>done());})));
    }finally{for(const child of children)if(child.exitCode===null)child.kill();await db.close();}
  });
  test('R-03 DDL/history failure releases the advisory lock and another pool recovers',async()=>{
    const db=await openTestDb(9);let peer:Database|undefined;try{
      const ids=await seed(db);await migrate(db,'postgres',10);peer=await openTestPeer(db);
      const source=await readFile(new URL('../migrations/011_class_name_legacy_updates.postgres.sql',import.meta.url),'utf8');
      const before=await snapshot(db),ledger=await db.all('SELECT * FROM schema_migrations ORDER BY id');
      for(const phase of ['ddl','history']){
        const broken=wrap(db,tx=>({...tx,exec:sql=>tx.exec(phase==='ddl'&&sql===source?source.replace('END;\n$migration$;',"RAISE EXCEPTION 'Synthetic DDL interruption';\nEND;\n$migration$;"):sql),
          run:async(sql,args=[])=>{if(phase==='history'&&sql.startsWith('INSERT INTO schema_migrations')&&String(args[0]).startsWith('011_'))throw new Error('Synthetic history interruption');return tx.run(sql,args);}}));
        await assert.rejects(migrate(broken,'postgres'),/Synthetic/);assert.equal(await snapshot(db),before);assert.deepEqual(await db.all('SELECT * FROM schema_migrations ORDER BY id'),ledger);
        assert.equal((await db.get("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='classes'::regclass AND conname='classes_name_length'"))!.n,1);
      }
      await migrate(peer,'postgres');await guards(db,ids);await db.exec(source);await migrate(db,'postgres');
    }finally{await peer?.close();await db.close();}
  });
  test('R-03 lock waits fail within the configured budget and recover after the holder commits',async()=>{
    const db=await openTestDb(0),peer=await openTestPeer(db),locked=barrier(),release=barrier();
    const holding=db.transaction(async tx=>{await tx.get("SELECT pg_advisory_xact_lock(hashtext('studypilot:migrations:' || current_database()), hashtext(current_schema()))");locked.resolve();await release.promise;});
    await locked.promise;
    try{
      const accelerated=wrap(peer,tx=>({...tx,exec:sql=>tx.exec(sql.startsWith('SET LOCAL lock_timeout')?"SET LOCAL lock_timeout = '100ms'; SET LOCAL statement_timeout = '2s'":sql)}));
      await assert.rejects(migrate(accelerated,'postgres'),(error:any)=>error.code==='55P03');
      assert.deepEqual(await peer.all('SELECT id FROM schema_migrations'),[]);
      release.resolve();await holding;await migrate(peer,'postgres');assert.equal((await peer.all('SELECT id FROM schema_migrations')).length,11);
    }finally{release.resolve();await holding;await peer.close();await db.close();}
  });
  test('R-03 advisory locks do not serialize unrelated disposable schemas',async()=>{
    const first=await openTestDb(0),second=await openTestDb(0),locked=barrier(),release=barrier();
    const holding=first.transaction(async tx=>{await tx.get("SELECT pg_advisory_xact_lock(hashtext('studypilot:migrations:' || current_database()), hashtext(current_schema()))");locked.resolve();await release.promise;});
    await locked.promise;
    try{await migrate(second,'postgres');assert.equal((await second.all('SELECT id FROM schema_migrations')).length,11);}
    finally{release.resolve();await holding;await second.close();await first.close();}
  });
  test('R-03 terminating a migration process rolls back DDL/history and releases its lock',async()=>{
    const db=await openTestDb(9);let child:ReturnType<typeof fork>|undefined;
    try{
      const ids=await seed(db);await migrate(db,'postgres',10);const before=await snapshot(db);
      const schema=String((await db.get('SELECT current_schema() AS name'))!.name);
      child=fork(new URL('./support/migrationStartupWorker.mjs',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:'',STUDYPILOT_TEST_SCHEMA:schema,STUDYPILOT_INTERRUPT_MIGRATION:'1'},stdio:['ignore','ignore','ignore','ipc']});
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Interrupted migration worker timed out')),20000);
        child!.on('message',(message:any)=>{
          if(message.phase==='ready')child!.send('go');
          if(message.phase==='ddl-ready'){clearTimeout(timer);resolve();}
          if(message.phase==='error'){clearTimeout(timer);reject(new Error('Interrupted migration worker failed before its barrier'));}
        });
        child!.once('error',()=>{clearTimeout(timer);reject(new Error('Could not start interrupted migration worker'));});
      });
      await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill();});
      assert.equal((await db.all('SELECT id FROM schema_migrations')).length,10);
      assert.equal((await db.get("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='classes'::regclass AND conname='classes_name_length'"))!.n,1);
      assert.equal(await snapshot(db),before);await migrate(db,'postgres');await guards(db,ids);
    }finally{if(child?.exitCode===null)child.kill();await db.close();}
  });
}
