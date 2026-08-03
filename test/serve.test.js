import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let home;
before(() => {
  home = mkdtempSync(join(tmpdir(), 'buddy-serve-'));
  process.env.BUDDY_HOME = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

const { buildStatus, serve, DEFAULT_HOST, DEFAULT_PORT } = await import('../dist/serve.js');
const { load, peek, save } = await import('../dist/state.js');
const { getDb, closeDb } = await import('../dist/db.js');
const { DRAIN_PER_HOUR, SESSION_GAP_HOURS } = await import('../dist/engine.js');

const NOW = new Date('2026-08-02T12:00:00Z');

function reset() {
  closeDb();
  for (const s of ['', '-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
  getDb();
  load(NOW);
}

function wipe() {
  closeDb();
  for (const s of ['', '-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
}

async function get(server, path) {
  const { port, address } = server.address();
  const host = address.includes(':') ? `[${address}]` : address;
  const res = await fetch(`http://${host}:${port}${path}`);
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : undefined };
}

async function withServer(fn) {
  const server = await serve({ port: 0, host: '127.0.0.1' });
  try {
    await fn(server);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(reset);

describe('peek', () => {
  it('reads the buddy without writing', () => {
    const before = getDb().prepare('SELECT * FROM buddy WHERE id = 1').get();
    const { state, unreadable } = peek();
    assert.equal(state.name, before.name);
    assert.equal(unreadable, false);
    const after = getDb().prepare('SELECT * FROM buddy WHERE id = 1').get();
    assert.deepEqual(after, before);
  });

  it('returns null instead of hatching when there is no buddy', () => {
    getDb().exec('DELETE FROM buddy');
    assert.deepEqual(peek(), { state: null, unreadable: false });
    const row = getDb().prepare('SELECT count(*) n FROM buddy').get();
    assert.equal(row.n, 0, 'peek must not hatch a replacement');
  });

  it('returns null, not unreadable, when the database file does not exist', () => {
    wipe();
    assert.deepEqual(peek(), { state: null, unreadable: false });
  });

  it('reports a corrupt database as unreadable rather than throwing', () => {
    closeDb();
    writeFileSync(join(home, 'buddy.db'), 'this is not a database');
    for (const s of ['-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
    const result = peek();
    assert.equal(result.state, null);
    assert.equal(result.unreadable, true, 'a corrupt db is not "no buddy yet"');
  });

  it('reports an unreadable database as unreadable, not as an absent buddy', () => {
    closeDb();
    const p = join(home, 'buddy.db');
    chmodSync(p, 0o000);
    try {
      const result = peek();
      assert.equal(result.state, null);
      assert.equal(result.unreadable, true);
    } finally {
      chmodSync(p, 0o644);
    }
  });

  it('does not create a database file as a side effect', () => {
    wipe();
    peek();
    assert.equal(existsSync(join(home, 'buddy.db')), false, 'a reader must not create the db');
  });
});

describe('buildStatus', () => {
  it('derives energy drain without persisting it', () => {
    const { state } = load(NOW);
    state.energy = 100;
    state.lastSeenAt = NOW.toISOString();
    save(state);

    const later = new Date(NOW.getTime() + 2 * 3600_000);
    const payload = buildStatus(peek().state,later);

    assert.ok(payload.energy < 100, 'energy should have drained in the view');
    assert.equal(payload.energy, 100 - 2 * DRAIN_PER_HOUR);

    const stored = getDb().prepare('SELECT energy FROM buddy WHERE id = 1').get();
    assert.equal(stored.energy, 100, 'stored energy must be untouched by a read');
  });

  it('reports a fresh session at full energy after a long gap', () => {
    const { state } = load(NOW);
    state.energy = 10;
    state.lastSeenAt = NOW.toISOString();
    save(state);

    const later = new Date(NOW.getTime() + (SESSION_GAP_HOURS + 1) * 3600_000);
    assert.equal(buildStatus(peek().state,later).energy, 100);
  });

  it('carries the fields a display needs', () => {
    const p = buildStatus(peek().state,NOW);
    for (const key of ['name', 'level', 'xp', 'xpForLevel', 'progress', 'energy', 'mood', 'stage']) {
      assert.ok(key in p, `missing ${key}`);
    }
    assert.ok(p.progress >= 0 && p.progress <= 1);
    assert.ok(p.mood.tier && p.mood.emoji && typeof p.mood.score === 'number');
    assert.ok(p.stage.id && p.stage.emoji);
  });

  it('never divides by zero on progress', () => {
    const p = buildStatus(peek().state,NOW);
    assert.ok(Number.isFinite(p.progress));
  });
});

describe('http surface', () => {
  it('serves the status as json', async () => {
    await withServer(async (server) => {
      const { res, json } = await get(server, '/status');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(json.name, peek().state.name);
    });
  });

  it('does not advertise CORS to browsers', async () => {
    await withServer(async (server) => {
      const { res } = await get(server, '/status');
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
  });

  it('answers /healthz without reading the buddy', async () => {
    await withServer(async (server) => {
      wipe();
      const { res, json } = await get(server, '/healthz');
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
    });
  });

  it('reports 503 rather than crashing when no buddy has hatched', async () => {
    await withServer(async (server) => {
      wipe();
      const { res, json } = await get(server, '/status');
      assert.equal(res.status, 503);
      assert.equal(json.error, 'no_buddy');
    });
  });

  it('distinguishes an unreadable database from an absent buddy', async () => {
    await withServer(async (server) => {
      closeDb();
      writeFileSync(join(home, 'buddy.db'), 'this is not a database');
      for (const s of ['-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
      const { res, json } = await get(server, '/status');
      assert.equal(res.status, 503);
      assert.equal(json.error, 'unreadable', 'must not claim the buddy never hatched');
    });
  });

  it('does not leak internal error text to callers', async () => {
    await withServer(async (server) => {
      closeDb();
      writeFileSync(join(home, 'buddy.db'), 'this is not a database');
      for (const s of ['-wal', '-shm']) rmSync(join(home, `buddy.db${s}`), { force: true });
      const { text } = await get(server, '/status');
      assert.ok(!text.includes('SQLITE'), 'no sqlite error codes in the response');
      assert.ok(!text.includes(home), 'no filesystem paths in the response');
    });
  });

  it('rejects writes', async () => {
    await withServer(async (server) => {
      const { port } = server.address();
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`http://127.0.0.1:${port}/status`, { method });
        assert.equal(res.status, 405, `${method} should be rejected`);
        assert.match(res.headers.get('allow') ?? '', /GET/);
      }
    });
  });

  it('404s an unknown route', async () => {
    await withServer(async (server) => {
      const { res, json } = await get(server, '/../../etc/passwd');
      assert.equal(res.status, 404);
      assert.equal(json.error, 'not_found');
    });
  });

  it('ignores the query string and trailing slashes', async () => {
    await withServer(async (server) => {
      assert.equal((await get(server, '/status?cache=bust')).res.status, 200);
      assert.equal((await get(server, '/status/')).res.status, 200);
    });
  });

  it('polling never advances lastSeenAt, energy or streak', async () => {
    await withServer(async (server) => {
      const before = getDb().prepare('SELECT * FROM buddy WHERE id = 1').get();
      for (let i = 0; i < 5; i++) await get(server, '/status');
      const after = getDb().prepare('SELECT * FROM buddy WHERE id = 1').get();
      assert.deepEqual(after, before, 'a poller must be invisible to the buddy');
    });
  });

  it('defaults to loopback', () => {
    assert.equal(DEFAULT_HOST, '127.0.0.1');
    assert.equal(typeof DEFAULT_PORT, 'number');
  });
});
