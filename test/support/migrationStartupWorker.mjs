import { openDb, migrate } from '../../src/db.ts';
import { requireTestDatabaseUrl } from './postgresSafety.ts';
const schema=process.env.STUDYPILOT_TEST_SCHEMA;
if(!schema||!/^studypilot_test_[a-f0-9]+$/.test(schema))throw new Error('An isolated test schema is required');
const url=new URL(requireTestDatabaseUrl(process.env.TEST_DATABASE_URL));
url.searchParams.set('options',`-c search_path=${schema}`);
process.send({phase:'ready'});
await new Promise(resolve=>process.once('message',resolve));
let db;
try{
  const interrupt=process.env.STUDYPILOT_INTERRUPT_MIGRATION==='1';
  db=await openDb(':memory:',{databaseUrl:url.toString(),migrationsThrough:interrupt?10:undefined});
  if(interrupt){
    const transaction=db.transaction.bind(db);
    db.transaction=operation=>transaction(tx=>operation({...tx,run:async(sql,args=[])=>{
      if(sql.startsWith('INSERT INTO schema_migrations')&&String(args[0]).startsWith('011_')){
        process.send({phase:'ddl-ready'});await new Promise(()=>{});
      }
      return tx.run(sql,args);
    }}));
    await migrate(db,'postgres');
  }
  const pid=(await db.get('SELECT pg_backend_pid() AS pid')).pid;
  const entries=(await db.all('SELECT id FROM schema_migrations')).length;
  await db.close();db=undefined;
  await new Promise(resolve=>process.send({phase:'started',pid,entries},resolve));
}catch(error){process.send({phase:'error',code:typeof error.code==='string'?error.code:'startup'});process.exitCode=1;}
finally{await db?.close();process.disconnect();}
