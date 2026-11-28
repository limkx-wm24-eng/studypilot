import { useState } from 'react';
import type { Store } from '../store';
import EmptyState from '../EmptyState';

type Props = Pick<Store, 'classes' | 'tasks' | 'addClass' | 'removeClass' | 'isPending'>;

export default function Classes({ classes, tasks, addClass, removeClass, isPending }: Props) {
  const [name, setName] = useState('');
  return (
    <>
      <p className="hint">Add the classes you take. Tasks and grades belong to a class.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await addClass(name.trim())) setName(''); }}>
        <fieldset className="app-content row" disabled={isPending('addClass')} aria-busy={isPending('addClass')}>
        <label>Class name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Database Systems" />
        </label>
        <button className="btn">Add class</button>
        </fieldset>
      </form>
      <div className="list">
        {classes.map((c) => {
          const own = tasks.filter((t) => t.classId === c.id);
          const done = own.filter((t) => t.status === 'Complete').length;
          const progressState = own.length > 0 && done === own.length ? 'complete' : done > 0 ? 'in-progress' : 'not-started';
          return (
            <div className="item" key={c.id}>
              <i className="dot" style={{ background: c.color }} />
              <div className="grow">
                <b>{c.name}</b><br /><span className="mut">{done} of {own.length} done</span>
                <div className="bar"><i className={`class-progress ${progressState}`} style={{ width: `${own.length ? (done / own.length) * 100 : 0}%` }} /></div>
              </div>
              <button className="x" aria-label={`Delete ${c.name}`}
                onClick={() => { if (confirm(`Delete ${c.name} and its ${own.length} tasks?`)) removeClass(c.id); }}>✕</button>
            </div>
          );
        })}
        {!classes.length && <EmptyState>No classes yet. Add your first one above.</EmptyState>}
      </div>
    </>
  );
}
