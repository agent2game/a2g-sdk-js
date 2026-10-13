// Offline checks against a fake decision service. Every message the client sends is validated against the A2G 0.1
// JSON Schema (sibling a2g-protocol checkout, A2G_SCHEMA, or the published copy at agent2game.org).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { A2G } from '../src/index.ts';

const SCHEMA_FILE = process.env.A2G_SCHEMA ?? new URL('../../a2g-protocol/schema/0.1/a2g.schema.json', import.meta.url).pathname;
const schema = existsSync(SCHEMA_FILE)
  ? JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
  : await (await fetch('https://agent2game.org/schema/0.1/a2g.schema.json')).json();
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const DEFS = { '/v1/session': 'SessionRequest', '/v1/context': 'ContextRequest', '/v1/decide': 'DecideRequest', '/v1/report': 'ReportRequest', '/v1/telemetry': 'TelemetryRequest' };

const MANIFEST = {
  world: 'Test arena.',
  scopes: { hall: { text: 'The great hall.' } },
  entity_types: {
    guard: { description: 'A guard.', fields: { hp: 'number', alert: 'boolean' }, actions: { attack: 'Attack', flee: 'Run away' },
      events: { hit: 'Was hit' }, decision_ttl_ms: 1000, refresh_ms: 2000 },
    hero: { description: 'The player.', fields: { hp: 'number' }, actions: {} },
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake service: records validated requests; `reply(path, body)` may override the default answers. */
function service(reply = () => undefined) {
  const sent = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    if (DEFS[path]) {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${DEFS[path]}`);
      assert.ok(validate(body), `${path} must match ${DEFS[path]}: ${ajv.errorsText(validate.errors)}`);
    }
    sent.push({ path, body });
    const custom = reply(path, body);
    if (custom instanceof Error) throw custom;
    const [status, data, headers] = custom ?? defaults(path, body);
    return new Response(JSON.stringify(data), { status, headers });
  };
  return { sent, fetch, paths: () => sent.map((m) => m.path) };
}

function defaults(path, body) {
  if (path === '/health') return [200, { service: 'a2g', a2g: '0.1', key_configured: true }];
  if (path === '/v1/session') return [200, { ok: true, a2g: '0.1', manifest_hash: 'sha256:' + '0'.repeat(64) }];
  if (path === '/v1/decide') {
    return [200, { a2g: '0.1', epoch: body.epoch, latency_ms: 5, decisions: body.entities.map((e, i) => (
      { id: e.id, source: 'AI', action: e.legal_actions[0], label: 'Attack', confidence: 0.9, ttl_ms: 1000, decision_id: `d_${e.id}_${i}` })) }];
  }
  return [200, { ok: true }];
}

function setup(reply, extra = {}) {
  const fake = service(reply);
  let clock = 1000;
  const world = { threat: 1 };
  const a2g = new A2G({ manifest: MANIFEST, fetch: fake.fetch, now: () => clock, world: () => world, game: 'Test', ...extra });
  const executed = [];
  const released = [];
  a2g.registerAdapter('guard', {
    observe: (g) => ({ hp: g.hp, alert: g.alert }),
    legalActions: (g) => g.legal ?? ['attack', 'flee'],
    execute: (g, action) => { executed.push([g.name, action]); return !g.blocked; },
    position: (g) => ({ x: g.x, y: 0.04 }),
    trigger: (g) => { const t = g.event; g.event = ''; return t; },
    release: (g) => released.push(g.name),
  });
  a2g.registerAdapter('hero', { observe: () => ({ hp: 10 }), legalActions: () => [], execute: () => true });
  return { a2g, fake, world, executed, released, advance: (ms) => { clock += ms; } };
}

const guard = (name, more = {}) => ({ name, hp: 10, alert: false, x: 1.234, ...more });

test('native mode asks nothing and execute() hands control to native AI', async () => {
  const { a2g, fake } = setup();
  const g = guard('g1');
  a2g.track(g, 'guard');
  await a2g.tick();
  assert.equal(a2g.execute(g, 0.016), false);
  await a2g.sendTelemetry();
  assert.deepEqual(fake.paths().filter((p) => p.startsWith('/v1')), ['/v1/telemetry']);
  assert.equal(fake.sent.find((m) => m.path === '/v1/telemetry').body.mode, 'native');
});

test('AI mode: session, batched decide, execute, report with deltas', async () => {
  const { a2g, fake, world, executed, advance } = setup();
  const g1 = guard('g1', { event: 'hit' });
  const g2 = guard('g2');
  const hero = { name: 'hero' };
  a2g.track(g1, 'guard', { profile: 'captain' });
  a2g.track(g2, 'guard', { parent: g1 });
  a2g.track(hero, 'hero');
  a2g.setAiEnabled(true);
  await a2g.tick();  // opens the session, then decides in the same tick
  const decide = fake.sent.find((m) => m.path === '/v1/decide').body;
  assert.equal(decide.entities.length, 2, 'observe-only types are never asked');
  assert.deepEqual(decide.entities[0].position, [1.2, 0]);
  assert.equal(decide.entities[0].trigger, 'hit');
  assert.equal(decide.entities[0].profile, 'captain');
  assert.equal(decide.entities[1].parent, a2g.entityId(g1));
  assert.equal(a2g.execute(g1, 0.016), true);
  assert.deepEqual(executed, [['g1', 'attack']]);
  assert.equal(a2g.decision(g1).decision_id, 'd_e1_0');

  g1.hp = 7.5;
  world.threat = 3;
  advance(1500);  // ttl 1000 ms: expired
  assert.equal(a2g.execute(g1, 0.016), false);
  const report = fake.sent.find((m) => m.path === '/v1/report').body;
  assert.equal(report.status, 'expired');
  assert.deepEqual(report.outcome, { hp_delta: -2.5, world_threat_delta: 2, seconds: 1.5 });
  await a2g.sendTelemetry();
  const telemetry = fake.sent.findLast((m) => m.path === '/v1/telemetry').body;
  assert.equal(telemetry.entities.length, 3, 'telemetry includes observe-only entities');
});

test('replies from an old epoch, illegal actions and missing ids fall back', async () => {
  let toggle = null;
  const { a2g } = setup((path, body) => {
    if (path !== '/v1/decide') return undefined;
    toggle?.();
    return [200, { a2g: '0.1', epoch: body.epoch, latency_ms: 1, decisions: [
      { id: body.entities[0].id, source: 'AI', action: 'dance', ttl_ms: 1000, decision_id: 'd_1' }] }];
  });
  const g = guard('g1');
  a2g.track(g, 'guard');
  a2g.setAiEnabled(true);
  await a2g.tick();
  assert.equal(a2g.execute(g, 0.016), false);
  assert.equal(a2g.decision(g).source, 'FALLBACK');

  toggle = () => { a2g.setAiEnabled(false); a2g.setAiEnabled(true); };  // epoch moves while the request is open
  await a2g.decideNow();
  assert.equal(a2g.decision(g), undefined, 'a stale reply is dropped');
});

test('a blocked action is reported as blocked', async () => {
  const { a2g, fake } = setup();
  const g = guard('g1', { blocked: true });
  a2g.track(g, 'guard');
  a2g.setAiEnabled(true);
  await a2g.decideNow();
  assert.equal(a2g.execute(g, 0.016), true);
  a2g.untrack(g);
  assert.equal(fake.sent.find((m) => m.path === '/v1/report').body.status, 'blocked');
});

test('turn-based: a decision that ran is reported as executed even when the turn outlasts its TTL', async () => {
  const { a2g, fake, advance } = setup();
  const g = guard('g1');
  a2g.track(g, 'guard');
  a2g.setAiEnabled(true);
  await a2g.decideNow();
  assert.equal(a2g.execute(g, 0), true);
  advance(120000);  // the player thinks for two minutes; the TTL is 1 s
  await a2g.decideNow();
  assert.deepEqual(fake.sent.filter((m) => m.path === '/v1/report').map((m) => m.body.status), ['executed']);
  advance(120000);
  assert.equal(a2g.execute(g, 0), false, 'a decision that was never executed and expired');
  await a2g.decideNow();
  assert.deepEqual(fake.sent.filter((m) => m.path === '/v1/report').map((m) => m.body.status), ['executed', 'expired']);
});

test('decideNow sends every entity in batches of 16', async () => {
  const { a2g, fake } = setup();
  const guards = Array.from({ length: 40 }, (_, i) => guard('g' + i));
  guards.forEach((g) => a2g.track(g, 'guard'));
  a2g.setAiEnabled(true);
  await a2g.decideNow();
  assert.deepEqual(fake.sent.filter((m) => m.path === '/v1/decide').map((m) => m.body.entities.length), [16, 16, 8]);
  assert.ok(guards.every((g) => a2g.execute(g, 1)));
});

test('409 reopens the session and replays context; 403 stops; 429 backs off', async () => {
  let status = 409;
  const { a2g, fake, advance } = setup((path) => (path === '/v1/decide' && status ? [status, { error: 'nope' }, { 'Retry-After': '7' }] : undefined));
  const g = guard('g1');
  a2g.track(g, 'guard');
  a2g.updateContext({ arena: { text: 'Boss arena.' } });
  a2g.setAiEnabled(true);
  await a2g.tick();
  assert.equal(a2g.sessionReady, false);
  advance(3000);
  status = 429;
  await a2g.tick();  // new session, context replayed, then a rate-limited decide
  assert.equal(fake.paths().filter((p) => p === '/v1/session').length, 2);
  assert.equal(fake.paths().filter((p) => p === '/v1/context').length, 2);
  assert.ok(a2g.scopeReady('arena'));
  const before = fake.sent.length;
  advance(5000);
  await a2g.tick();
  assert.equal(fake.sent.length, before, 'no requests before Retry-After');
  advance(3000);
  status = 403;
  await a2g.tick();
  assert.equal(a2g.forbidden, true);
  advance(10000);
  await a2g.tick();
  assert.equal(fake.paths().at(-1), '/v1/decide', 'nothing after 403');
  assert.equal(a2g.execute(g, 0.016), false);
});

test('an offline service never throws and leaves native AI in control', async () => {
  const { a2g } = setup(() => new TypeError('fetch failed'));
  const g = guard('g1');
  a2g.track(g, 'guard');
  a2g.setAiEnabled(true);
  await a2g.tick();
  await a2g.decideNow();
  await a2g.sendTelemetry();
  assert.equal(a2g.execute(g, 0.016), false);
  assert.match(a2g.lastError, /Session rejected/);
});

test('a paused game asks for nothing', async () => {
  const { a2g, fake } = setup(undefined, { paused: () => true, scene: 'Level 2' });
  a2g.track(guard('g1'), 'guard');
  a2g.setAiEnabled(true);
  await a2g.tick();
  await a2g.sendTelemetry();
  assert.deepEqual(fake.paths().filter((p) => p.startsWith('/v1')), ['/v1/telemetry']);
  assert.equal(fake.sent.at(-1).body.paused, true);
  assert.equal(fake.sent.at(-1).body.scene, 'Level 2');
});

test('start() runs on timers and stop() ends them', async () => {
  const { a2g, fake } = setup(undefined, { batchIntervalMs: 5, telemetryIntervalMs: 5 });
  a2g.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  a2g.stop();
  await flush();
  const count = fake.sent.length;
  assert.ok(fake.paths().includes('/v1/telemetry'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.sent.length, count);
});
