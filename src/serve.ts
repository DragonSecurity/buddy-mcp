import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  applySessionEnergy,
  hoursSince,
  LOW_ENERGY,
  moodScore,
  moodTier,
  stageFor,
  xpForLevel,
} from './engine.js';
import { PERSONALITIES } from './personality.js';
import { MOOD_EMOJI } from './render.js';
import { peek } from './state.js';
import type { BuddyState } from './types.js';

export const DEFAULT_PORT = 8787;

/**
 * Loopback, not 0.0.0.0. Reaching this from an ESP8266 on the LAN needs
 * `--host 0.0.0.0`, and that has to be a decision someone types, not a default
 * they inherit. The payload is a toy, but it is a toy that names your machine's
 * owner and broadcasts when they are at the keyboard.
 */
export const DEFAULT_HOST = '127.0.0.1';

export interface StatusPayload {
  name: string;
  personality: string;
  bio: string;
  stage: { id: string; name: string; emoji: string };
  level: number;
  xp: number;
  xpForLevel: number;
  progress: number;
  totalXp: number;
  energy: number;
  lowEnergy: boolean;
  mood: { tier: string; emoji: string; label: string; score: number };
  streak: number;
  longestStreak: number;
  observations: number;
  bornAt: string;
  lastSeenAt: string;
  idleHours: number;
  lastReaction: string;
  generatedAt: string;
}

const round = (n: number, places = 0) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Derives the same numbers the status card shows, on a copy.
 *
 * `applySessionEnergy` mutates, and the value it produces is a function of
 * `lastSeenAt` and now — so a reader can compute the live figure itself and
 * must not persist the result. Everything here is a pure view over stored
 * state; nothing it does is visible to the buddy.
 */
export function buildStatus(state: BuddyState, now: Date): StatusPayload {
  const view: BuddyState = { ...state };
  applySessionEnergy(view, now);

  const score = moodScore(view, now);
  const tier = moodTier(score, view.energy);
  const stage = stageFor(view.level);
  const need = xpForLevel(view.level);
  const personality = PERSONALITIES[view.personality];

  return {
    name: view.name,
    personality: view.personality,
    bio: view.bio,
    stage: { id: stage.id, name: stage.name, emoji: stage.emoji },
    level: view.level,
    xp: view.xp,
    xpForLevel: need,
    progress: need > 0 ? round(Math.min(1, view.xp / need), 4) : 0,
    totalXp: view.totalXp,
    energy: round(view.energy, 1),
    lowEnergy: view.energy < LOW_ENERGY,
    mood: {
      tier,
      emoji: MOOD_EMOJI[tier],
      label: personality?.moods[tier] ?? tier,
      score: round(score),
    },
    streak: view.streak,
    longestStreak: view.longestStreak,
    observations: view.observations,
    bornAt: view.bornAt,
    lastSeenAt: view.lastSeenAt,
    idleHours: round(hoursSince(view.lastSeenAt, now), 2),
    lastReaction: view.lastReaction,
    generatedAt: now.toISOString(),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    // A display should never render a stale mood, and no browser or proxy
    // between here and the ESP has any business keeping this.
    'cache-control': 'no-store',
    // Deliberately no Access-Control-Allow-Origin: a microcontroller does not
    // send preflights, and adding one would let any page the user happens to
    // visit read this off their loopback.
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

export function handle(req: IncomingMessage, res: ServerResponse, now = new Date()): void {
  // Only the path matters; the Host header is untrusted and unused.
  const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    send(res, 405, { error: 'method_not_allowed', allow: ['GET', 'HEAD'] });
    return;
  }

  if (path === '/healthz') {
    send(res, 200, { ok: true, generatedAt: now.toISOString() });
    return;
  }

  if (path !== '/status' && path !== '/') {
    send(res, 404, { error: 'not_found', routes: ['/status', '/healthz'] });
    return;
  }

  const { state, unreadable } = peek();
  if (unreadable) {
    // Distinct from no_buddy on purpose: this one means "there is a buddy and
    // something is wrong", which is a different thing for a display to show
    // and a different thing for the user to go and fix.
    send(res, 503, { error: 'unreadable', message: 'The buddy database could not be read.' });
    return;
  }
  if (!state) {
    // No buddy yet is not a server fault — it is a state the display should be
    // able to show ("no buddy") rather than a crash or an empty body.
    send(res, 503, { error: 'no_buddy', message: 'No buddy has hatched yet.' });
    return;
  }

  send(res, 200, buildStatus(state, now));
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

export function createStatusServer(): Server {
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // The detail goes to the operator's terminal, not to an unauthenticated
      // caller — an error string is an uncontrolled channel out of internal
      // state, and this one can be reached from the LAN.
      process.stderr.write(
        `[serve] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      send(res, 500, { error: 'internal' });
    }
  });

  // A microcontroller with a flaky radio can leave sockets half-open; without
  // these a stalled poller would hold a connection indefinitely.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  // Each request opens its own SQLite handle and `busy_timeout = 5000` lets one
  // block for five seconds behind a write, so unbounded connections can pile
  // up. A display needs one; this leaves room for a dashboard and a curl.
  server.maxConnections = 32;
  return server;
}

export function serve(opts: ServeOptions = {}): Promise<Server> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const server = createStatusServer();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
