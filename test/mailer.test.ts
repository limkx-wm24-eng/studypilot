import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleMailer, createMailer } from '../src/mailer.js';

test('development console links remain usable without logging recipient information', async () => {
  const mode = process.env.NODE_ENV;
  const info = console.info;
  const output: unknown[][] = [];
  console.info = (...args) => { output.push(args); };
  try {
    process.env.NODE_ENV = 'development';
    const text = 'http://localhost:3000/?reset=synthetic-token';
    await createMailer({ NODE_ENV: 'development', MAIL_PROVIDER: 'console' }).send({ to: 'synthetic@example.test', subject: 'Synthetic reset', text });
    assert.equal(output.length, 1);
    assert.equal(output[0][1], text);
    assert.ok(!JSON.stringify(output).includes('synthetic@example.test'));
    process.env.NODE_ENV = 'test';
    await new ConsoleMailer().send({ to: 'synthetic@example.test', subject: 'Synthetic reset', text });
    assert.equal(output.length, 1);
  } finally {
    if (mode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = mode;
    console.info = info;
  }
});

test('production cannot emit console token links, even through a development-created mailer', async () => {
  const originalMode = process.env.NODE_ENV;
  const info = console.info;
  const warn = console.warn;
  const output: unknown[][] = [];
  console.info = (...args) => { output.push(args); };
  console.warn = () => {};
  try {
    process.env.NODE_ENV = 'development';
    const developmentMailer = createMailer({ NODE_ENV: 'development', MAIL_PROVIDER: 'console' });
    process.env.NODE_ENV = 'production';
    const email = { to: 'synthetic@example.test', subject: 'Synthetic reset', text: 'https://example.test/?reset=synthetic-token' };
    await developmentMailer.send(email);
    await new ConsoleMailer().send(email);
    await createMailer({ NODE_ENV: 'production', MAIL_PROVIDER: 'console' }).send(email);
    assert.throws(() => createMailer({ NODE_ENV: 'production', MAIL_PROVIDER: 'console', MAIL_API_KEY: 'synthetic-key' }), /cannot be used in production/);
    assert.deepEqual(output, []);
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
    console.info = info;
    console.warn = warn;
  }
});
