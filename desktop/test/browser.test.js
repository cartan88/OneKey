'use strict';

/**
 * Tests for the browser-integration logic: host matching, credential scoping,
 * save classification, and the bridge protocol over a real named pipe.
 *
 *   npm test
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const assert = require('assert');

const { Vault } = require('../src/vault.js');
const { generatePassword } = require('../src/crypto.js');
const { Bridge, pipeName } = require('../src/bridge.js');
const { hostOf, hostsMatch, entryMatchesUrl, nameFromUrl } = require('../src/match.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-browser-'));
const log = (...a) => console.log('  ok', ...a);

(async () => {
  // ------------------------------------------------------------------ matching

  assert.strictEqual(hostOf('https://WWW.GitHub.com/login?x=1'), 'github.com');
  assert.strictEqual(hostOf('github.com'), 'github.com');
  assert.strictEqual(hostOf('javascript:alert(1)'), '');
  assert.strictEqual(hostOf('file:///c:/x'), '');
  assert.strictEqual(hostOf(''), '');
  log('hostOf normalises hosts and rejects non-http schemes');

  assert.ok(hostsMatch('github.com', 'github.com'));
  assert.ok(hostsMatch('google.com', 'accounts.google.com'));
  assert.ok(hostsMatch('accounts.google.com', 'google.com'));
  assert.ok(!hostsMatch('evilgoogle.com', 'google.com'), 'must not match on a bare suffix');
  assert.ok(!hostsMatch('google.com.attacker.net', 'google.com'));
  assert.ok(!hostsMatch('com', 'google.com'), 'a single label must never match');
  assert.ok(!hostsMatch('github.com', 'gitlab.com'));
  log('hostsMatch allows dot-boundary suffixes and rejects look-alike domains');

  assert.strictEqual(nameFromUrl('https://accounts.google.com/signin'), 'Google');
  assert.strictEqual(nameFromUrl('https://github.com'), 'Github');
  log('nameFromUrl derives a sensible entry name');

  // --------------------------------------------------------------------- vault

  const v = new Vault(dir);
  await v.create('a master password');

  const gh = await v.addEntry({
    name: 'GitHub',
    username: 'ctan',
    password: 'gh-secret-1',
    url: 'https://github.com',
  });
  await v.addEntry({
    name: 'Google',
    username: 'me@gmail.com',
    password: 'goog-secret-1',
    url: 'https://google.com',
  });
  await v.addEntry({ name: 'No URL', username: 'x', password: 'y' });

  const forGitHub = v.matchEntriesForUrl('https://github.com/login');
  assert.deepStrictEqual(forGitHub.map((e) => e.name), ['GitHub']);
  assert.ok(!('password' in forGitHub[0]), 'match results must not carry passwords');
  log('matchEntriesForUrl returns only the matching entry, without passwords');

  assert.deepStrictEqual(
    v.matchEntriesForUrl('https://accounts.google.com/x').map((e) => e.name),
    ['Google']
  );
  assert.deepStrictEqual(v.matchEntriesForUrl('https://example.org'), []);
  assert.deepStrictEqual(v.matchEntriesForUrl('javascript:void 0'), []);
  log('subdomains match, unrelated and non-http pages do not');

  const cred = v.credentialFor(gh.id, 'https://github.com/session');
  assert.strictEqual(cred.password, 'gh-secret-1');
  log('credentialFor returns the credential for a matching page');

  assert.throws(
    () => v.credentialFor(gh.id, 'https://evil.example/'),
    (e) => e.code === 'ORIGIN_MISMATCH',
    'a mismatched origin must be refused even with a valid entry id'
  );
  log('credentialFor refuses an entry that does not belong to the page');

  // ------------------------------------------------------------ save decisions

  assert.strictEqual(
    v.classifySave({ url: 'https://github.com/x', username: 'ctan', password: 'gh-secret-1' }).action,
    'known'
  );
  assert.strictEqual(
    v.classifySave({ url: 'https://github.com/x', username: 'ctan', password: 'changed!' }).action,
    'update'
  );
  assert.strictEqual(
    v.classifySave({ url: 'https://github.com/x', username: 'other', password: 'p' }).action,
    'new'
  );
  assert.strictEqual(
    v.classifySave({ url: 'https://newsite.test/x', username: 'ctan', password: 'p' }).action,
    'new'
  );
  log('classifySave separates known, changed, and new logins');

  // A different username on the same host must never overwrite the first one.
  const before = v.revealPassword(gh.id);
  const created = await v.applySave({
    url: 'https://github.com/login',
    username: 'second-account',
    password: 'other-secret',
  });
  assert.strictEqual(created.action, 'created');
  assert.strictEqual(v.revealPassword(gh.id), before, 'the original entry must be untouched');
  assert.strictEqual(v.matchEntriesForUrl('https://github.com').length, 2);
  log('a new username on a known host creates an entry instead of overwriting');

  const updated = await v.applySave({
    url: 'https://github.com/login',
    username: 'ctan',
    password: 'gh-secret-2',
  });
  assert.strictEqual(updated.action, 'updated');
  assert.strictEqual(v.revealPassword(gh.id), 'gh-secret-2');
  log('the same host + username updates that entry password');

  const fresh = await v.applySave({
    url: 'https://shop.example.com/checkout?token=abc',
    username: 'me',
    password: 'p@ssw0rd-here',
  });
  assert.strictEqual(fresh.action, 'created');
  const shop = v.listEntries().find((e) => e.name === 'Example');
  assert.strictEqual(shop.url, 'https://shop.example.com', 'only the origin should be stored');
  log('captured logins store the origin only — no paths or query strings');

  await assert.rejects(
    () => v.applySave({ url: 'https://x.test', username: 'a', password: '' }),
    (e) => e.code === 'NO_PASSWORD'
  );
  log('a save with no password is refused');

  // ------------------------------------------------------------------- bridge

  const activity = [];
  const bridge = new Bridge({
    dir,
    handlers: {
      status: () => ({ state: 'unlocked', itemCount: v.listEntries().length }),
      match: (url) => v.matchEntriesForUrl(url),
      credential: (id, url) => v.credentialFor(id, url),
      checkSave: (input) => v.classifySave(input),
      save: (input) => v.applySave(input),
      generate: (options) => generatePassword(options || {}),
    },
    onActivity: (kind, detail) => activity.push({ kind, ...detail }),
  });

  await bridge.start();
  assert.ok(bridge.isRunning);

  const config = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'));
  assert.strictEqual(config.token.length, 64);
  assert.ok(pipeName().endsWith(config.pipeName), 'config must name the live pipe');
  const token = config.token;
  log('bridge published bridge.json and is listening on', pipeName());

  /** Minimal client: connect, optionally authenticate, send lines, collect replies. */
  function client() {
    const socket = net.connect(pipeName());
    socket.setEncoding('utf8');
    const queue = [];
    const waiters = [];
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (waiters.length) waiters.shift()(msg);
        else queue.push(msg);
      }
    });

    return {
      socket,
      ready: new Promise((res, rej) => {
        socket.once('connect', res);
        socket.once('error', rej);
      }),
      next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
      send(msg) {
        socket.write(`${JSON.stringify(msg)}\n`);
      },
      closed: new Promise((res) => socket.once('close', res)),
    };
  }

  // A wrong token gets nothing and gets dropped.
  {
    const c = client();
    await c.ready;
    c.send({ type: 'hello', token: 'f'.repeat(64), rid: 1 });
    const reply = await c.next();
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.code, 'UNAUTHORIZED');
    await c.closed;
    log('bridge rejects a bad token and closes the socket');
  }

  // Requests before authenticating are refused too.
  {
    const c = client();
    await c.ready;
    c.send({ type: 'match', url: 'https://github.com', rid: 1 });
    const reply = await c.next();
    assert.strictEqual(reply.code, 'UNAUTHORIZED');
    await c.closed;
    log('bridge refuses requests sent before the handshake');
  }

  // The real conversation.
  {
    const c = client();
    await c.ready;
    c.send({ type: 'hello', token, rid: 0 });
    assert.strictEqual((await c.next()).code, 'HELLO');

    c.send({ type: 'status', rid: 1 });
    const status = await c.next();
    assert.strictEqual(status.rid, 1);
    assert.strictEqual(status.state, 'unlocked');

    c.send({ type: 'match', url: 'https://github.com/login', rid: 2 });
    const match = await c.next();
    assert.strictEqual(match.rid, 2);
    assert.strictEqual(match.items.length, 2);

    const target = match.items.find((i) => i.username === 'ctan');
    c.send({ type: 'credential', id: target.id, url: 'https://github.com/login', rid: 3 });
    const got = await c.next();
    assert.strictEqual(got.rid, 3, 'reply must correlate by rid, not entry id');
    assert.strictEqual(got.password, 'gh-secret-2');
    assert.strictEqual(activity.at(-1).kind, 'fill');

    // Same entry id, wrong page.
    c.send({ type: 'credential', id: target.id, url: 'https://evil.test/', rid: 4 });
    const denied = await c.next();
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'ORIGIN_MISMATCH');

    c.send({ type: 'save', url: 'https://bridge.test/in', username: 'u', password: 'pw-1', rid: 5 });
    const saved = await c.next();
    assert.strictEqual(saved.action, 'created');
    assert.strictEqual(activity.at(-1).kind, 'created');

    // Generation over the bridge, for signup forms.
    c.send({ type: 'generate', options: { length: 24 }, rid: 6 });
    const gen = await c.next();
    assert.strictEqual(gen.rid, 6);
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.password.length, 24);
    assert.ok(
      /[a-z]/.test(gen.password) && /[A-Z]/.test(gen.password) &&
        /[0-9]/.test(gen.password) && /[^A-Za-z0-9]/.test(gen.password),
      `generated password should span every class: ${gen.password}`
    );

    c.send({ type: 'generate', options: { length: 24 }, rid: 7 });
    assert.notStrictEqual((await c.next()).password, gen.password, 'each request must differ');

    c.send({ type: 'nonsense', rid: 8 });
    assert.strictEqual((await c.next()).code, 'UNKNOWN_REQUEST');

    c.socket.destroy();
    log('bridge serves status, match, credential, save and generate — scoped by origin');
  }

  // Locking must take the pipe away entirely.
  await bridge.stop();
  assert.strictEqual(bridge.isRunning, false);
  assert.ok(!fs.existsSync(path.join(dir, 'bridge.json')), 'bridge.json must be removed on stop');
  await assert.rejects(
    () =>
      new Promise((res, rej) => {
        const s = net.connect(pipeName());
        s.once('connect', () => {
          s.destroy();
          res();
        });
        s.once('error', rej);
      }),
    'the pipe must be gone once stopped'
  );
  log('stopping the bridge removes the pipe and its config');

  console.log('\nAll browser-integration tests passed.');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error('\nFAILED:', err);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
