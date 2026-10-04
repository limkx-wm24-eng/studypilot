import { useState } from 'react';
import type { Store } from '../store';

type Props = Pick<Store, 'classes' | 'tasks' | 'addClass' | 'removeClass'>;

export default function Classes({ classes, tasks, addClass, removeClass }: Props) {
  const [name, setName] = useState('');
  return (
    <>
      <p className="hint">Add the classes you take. Tasks and grades belong to a class.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await addClass(name.trim()); setName(''); }}>
        <label>Class name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="e.g. Database Systems" />
        </label>
        <button className="btn">Add class</button>
      </form>
      <div className="list">
        {classes.map((c) => {
          const own = tasks.filter((t) => t.classId === c.id);
          const done = own.filter((t) => t.status === 'Complete').length;
          return (
            <div className="item" key={c.id}>
              <i className="dot" style={{ background: c.color }} />
              <div className="grow">
                <b>{c.name}</b><br /><span className="mut">{done} of {own.length} done</span>
                <div className="bar"><i style={{ width: `${own.length ? (done / own.length) * 100 : 0}%`, background: c.color }} /></div>
              </div>
              <button className="x" aria-label={`Delete ${c.name}`}
                onClick={() => { if (confirm(`Delete ${c.name} and its ${own.length} tasks?`)) removeClass(c.id); }}>✕</button>
            </div>
          );
        })}
        {!classes.length && <p className="mut">No classes yet. Add your first one above.</p>}
      </div>
    </>
  );
}
