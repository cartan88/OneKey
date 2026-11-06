'use strict';

/**
 * Local bridge between the running One Key app and the native messaging host
 * that Chrome launches.
 *
 * Transport is a Windows named pipe carrying newline-delimited JSON. The pipe
 * only exists while the vault is unlocked and browser integration is on, so a
 * locked vault is unreachable by construction rather than by a check.
 *
 * Security note, stated plainly: a named pipe is reachable by any process
 * running as the same user, and so is the token file that guards it. This
 * therefore adds no defence against a same-user attacker — but that attacker
 * could already read this process's memory, which is where the decrypted vault
 * lives, so the pipe does not widen the threat model described in the README.
 * What the token does buy is refusing connections from lower-integrity
 * processes that cannot read the token file (a sandboxed browser renderer, for
 * one) and preventing accidental cross-talk from unrelated software.
 *
 * The API is deliberately narrow: it can list matches for a URL without
 * passwords, hand over exactly one credential for a URL it verifies, classify a
 * save, apply a save, and generate a fresh password. It cannot export the vault.
 */

const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_LINE_BYTES = 64 * 1024; // a credential is small; anything larger is junk or an attack

/**
 * Per-user pipe name — pipe names are machine-global, so they must not collide
 * between accounts. The host helper never recomputes this; it reads the name out
 * of bridge.json, so the two sides cannot drift apart.
 */
function pipeShortName() {
  const who = crypto
    .createHash('sha256')
    .update(`${os.userInfo().username}@${os.hostname()}`)
    .digest('hex')
    .slice(0, 16);
  return `one-key-${who}`;
}

function pipeName() {
  return `\\\\.\\pipe\\${pipeShortName()}`;
}

class Bridge {
  /**
   * @param {object} options
   * @param {string} options.dir           directory for the token file
   * @param {object} options.handlers      { status, match, credential, checkSave, save }
   * @param {(kind: string, detail: object) => void} [options.onActivity]
   */
  constructor({ dir, handlers, onActivity = () => {} }) {
    this.dir = dir;
    // Present only while the bridge is live; the host helper treats its absence
    // as "One Key is closed or locked", which is exactly right.
    this.configFile = path.join(dir, 'bridge.json');
    this.handlers = handlers;
    this.onActivity = onActivity;

    this.server = null;
    this.token = null;
    this.sockets = new Set();
  }

  get isRunning() {
    return this.server !== null;
  }

  async start() {
    if (this.server) return;

    await fsp.mkdir(this.dir, { recursive: true });
    this.token = crypto.randomBytes(32).toString('hex');

    const name = pipeName();
    this.server = net.createServer((socket) => this._onConnection(socket));

    this.server.on('error', (err) => {
      console.error('[one-key] bridge error:', err.message);
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(name, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });

    // Published only after the pipe is actually accepting connections, so the
    // helper never sees a config pointing at a pipe that isn't there yet.
    // mode 0600 is advisory on Windows but costs nothing and is right elsewhere.
    await fsp.writeFile(
      this.configFile,
      JSON.stringify({ pipeName: pipeShortName(), token: this.token }),
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  async stop() {
    // Remove the config first: it is what advertises the bridge, so taking it
    // away before closing sockets avoids a window where a helper connects to a
    // pipe that is about to disappear.
    try {
      if (fs.existsSync(this.configFile)) await fsp.unlink(this.configFile);
    } catch {
      /* the token is useless without a live pipe anyway */
    }

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    this.token = null;
  }

  // ------------------------------------------------------------------ internals

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.setEncoding('utf8');

    let buffer = '';
    let authed = false;

    const reply = (payload) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    };

    const handleData = async (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        reply({ ok: false, code: 'TOO_LARGE' });
        socket.destroy();
        return;
      }

      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          reply({ ok: false, code: 'BAD_JSON' });
          socket.destroy();
          return;
        }

        // Valid JSON is not necessarily a request: `null`, a number or an array
        // would make every property read below throw. Anything that is not a
        // plain object is refused before it is looked at, authenticated or not.
        if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
          reply({ ok: false, code: 'BAD_JSON' });
          socket.destroy();
          return;
        }

        // The first line must authenticate, and nothing else is served until it does.
        if (!authed) {
          if (msg.type !== 'hello' || typeof msg.token !== 'string' || !this._tokenOk(msg.token)) {
            reply({ rid: msg.rid, ok: false, code: 'UNAUTHORIZED' });
            socket.destroy();
            return;
          }
          authed = true;
          reply({ rid: msg.rid, ok: true, code: 'HELLO' });
          continue;
        }

        reply(await this._dispatch(msg));
      }
    };

    // An async listener's failure is an unhandled rejection in the main process,
    // so nothing may escape this wrapper: the worst a bad peer gets is a closed
    // connection.
    socket.on('data', (chunk) => {
      handleData(chunk).catch((err) => {
        console.error('[one-key] bridge connection error:', err.message);
        socket.destroy();
      });
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
  }

  _tokenOk(candidate) {
    if (!this.token) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * `rid` correlates request and reply; `id`, where present, is a vault entry id.
   * Keeping those in separate fields matters — collapsing them into one silently
   * breaks credential lookups.
   */
  async _dispatch(msg) {
    const rid = msg.rid;
    try {
      switch (msg.type) {
        case 'status': {
          return { rid, ok: true, ...this.handlers.status() };
        }
        case 'match': {
          return { rid, ok: true, items: this.handlers.match(msg.url) };
        }
        case 'credential': {
          const cred = this.handlers.credential(msg.id, msg.url);
          this.onActivity('fill', { name: cred.name, url: msg.url });
          return { rid, ok: true, username: cred.username, password: cred.password };
        }
        case 'generate': {
          return { rid, ok: true, password: this.handlers.generate(msg.options) };
        }
        case 'checkSave': {
          const result = this.handlers.checkSave({
            url: msg.url,
            username: msg.username,
            password: msg.password,
          });
          return { rid, ok: true, ...result };
        }
        case 'save': {
          const result = await this.handlers.save({
            url: msg.url,
            username: msg.username,
            password: msg.password,
            name: msg.name,
          });
          this.onActivity(result.action, { name: result.entry.name, url: msg.url });
          return { rid, ok: true, action: result.action };
        }
        default:
          return { rid, ok: false, code: 'UNKNOWN_REQUEST' };
      }
    } catch (err) {
      return {
        rid,
        ok: false,
        code: err.code || 'UNEXPECTED',
        message: err.code ? err.message : 'One Key could not complete that request.',
      };
    }
  }
}

module.exports = { Bridge, pipeName, pipeShortName };
