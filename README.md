# A2G SDK for JavaScript and TypeScript

Client for the [A2G (Agent2Game) protocol](https://agent2game.org) 0.1 for web and Node games: browser games (Phaser, PixiJS, Three.js, plain canvas) and server-side or turn-based games (Node, Next.js, Deno, Bun). It contains no game-specific code and has no runtime dependencies.

| SDK | Protocol | Runtime |
| --- | --- | --- |
| `0.1.0` | `0.1` | Browsers with `fetch`; Node 22.18+ |

## Install

Not on npm yet. Install from GitHub (the package builds itself on install):

```sh
npm install github:agent2game/a2g-sdk-js#v0.1.0
```

## Demo

A browser page with a player and four guards (plain canvas, no build tools), the same scene as the Godot SDK demo. Start the [decision service](https://agent2game.org/implementations/service/) first, then:

```sh
npm ci && npm run build && npm run demo   # http://127.0.0.1:5180/
```

Move with the arrow keys or WASD, hit guards with Space, switch AI mode with the button or `M`. Colors show who controls each guard: blue native AI, green an A2G decision (with its confidence), amber fallback. `demo/serve.mjs` serves the page and forwards `/a2g/*` to the service (`A2G_URL`, default `http://127.0.0.1:8787`) without the browser's `Origin`, as the local profile requires; the session shows up in the Agent2Game Console.

## Real-time games

```ts
import { A2G } from '@agent2game/a2g';
import manifest from './a2g_manifest.json';

const a2g = new A2G({
  manifest,
  url: 'http://127.0.0.1:8787',
  game: 'My game',
  world: () => ({ time_of_day: 'night' }),              // shared world state
  scope: () => ({ scope: 'cave', state: { lit: false } }), // active scope, or null
  paused: () => game.paused,                             // paused: telemetry only, no decisions
  scene: () => game.levelName,
});

a2g.registerAdapter('bee', {
  observe: (bee) => ({ hp_fraction: bee.hp / bee.maxHp, sees_player: bee.seesPlayer }),
  legalActions: (bee) => (bee.stunned ? [] : ['chase', 'flee', 'wander']),
  execute: (bee, action, dt) => bee.perform(action, dt), // false = blocked, the adapter did something safe
  position: (bee) => ({ x: bee.x, y: bee.y }),           // optional: nearby entities and groups
  state: (bee) => bee.fsmState,                          // optional: actual state for telemetry
});

a2g.start();                         // batches decisions every 250 ms, telemetry every second
a2g.track(bee, 'bee', { name: 'Bee 1' });

// in the game loop, for each entity
if (!a2g.execute(bee, dt)) bee.runNativeAi(dt);

a2g.setAiEnabled(true);              // native AI is the default; this starts asking
```

## Turn-based and server-side games

Skip `start()`. Ask once per turn and wait, then apply:

```ts
a2g.setAiEnabled(true);
await a2g.decideNow();               // every tracked entity, in batches of 16, each wave capped at 4 s
for (const person of people) {
  if (!a2g.execute(person, 0)) applyNativeChoice(person);
}
await a2g.sendTelemetry();           // or call start() just for telemetry
```

Keep the client on the server when the game state must not reach the browser.

## Adapter contract

| Method | Required | Purpose |
| --- | --- | --- |
| `observe(entity)` | yes | Observation fields declared for the type |
| `legalActions(entity)` | yes | Actions allowed now; empty means "do not ask" (observe-only types such as the player) |
| `execute(entity, action, dt)` | yes | Perform the action; `false` = blocked, the adapter did something safe instead |
| `state(entity)` | no | Actual executed state for telemetry |
| `position(entity)` | no | `[x, y]`, `[x, y, z]` or `{x, y, z?}`; enables `nearby` and group members |
| `trigger(entity)` | no | Name of a manifest event that just happened, or `""`; asks for a decision soon |
| `intervalMs(entity)` | no | Refresh interval (default: the type's `refresh_ms`, then 3000 ms) |
| `release(entity)` | no | Called when native AI takes control back |

Other calls: `track(entity, type, { id, name, profile, parent })`, `untrack(entity)` (reports the open decision), `setParent(entity, parent)`, `updateContext(scopes, profiles)`, `scopeReady(name)`, `decision(entity)`, `entityId(entity)`, `stop()`. Status fields: `serviceStatus`, `sessionReady`, `lastError`, `epoch`, `forbidden`.

## What it does

Same behavior as the [Godot SDK](https://agent2game.org/implementations/godot-sdk/): opens a session and reopens it after `401`/`409`, replaying context updates; sends up to 16 entities per decide request with at most 2 in flight; re-asks everyone (after at least 500 ms) when the number of tracked entities changes; drops replies from an old epoch, re-checks that the action was offered and has a `decision_id`, expires decisions after `ttl_ms`; reports each finished decision with numeric deltas; sends telemetry every second and checks `/health` every 5 s; stops after `403`, waits for `Retry-After` after `429`. Network errors never throw.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | `http://127.0.0.1:8787` | Decision service base URL |
| `maxBatch` | `16` | Entities per decide request (protocol maximum 16) |
| `maxInflight` | `2` | Decide requests open at once |
| `batchIntervalMs` | `250` | Batching step of `start()` |
| `defaultIntervalMs` | `3000` | Refresh interval when neither the adapter nor the manifest sets one |
| `minIntervalMs` | `500` | Minimum time between two requests for one entity |
| `telemetryIntervalMs` | `1000` | Telemetry period of `start()` |
| `headers` | none | Extra request headers (for future `server`/`client` profile credentials) |
| `fetch`, `now` | globals | Injected for tests |

## Browser games and the local service

The local profile rejects other origins, so a page on `http://localhost:5173` cannot call `http://127.0.0.1:8787` until you list it. Two ways:

1. **List the dev server's origin** (simplest). Start the service with exact loopback origins, comma-separated: `A2G_ALLOWED_ORIGINS=http://localhost:5173`. The service then answers CORS for `/v1/*` and `/health` from those origins only (never `*`, never console routes). Use `new A2G({ manifest, url: 'http://127.0.0.1:8787' })`.
2. **Proxy through the dev server** and drop the browser's `Origin`, for example with Vite:

```ts
// vite.config.ts
export default {
  server: {
    proxy: {
      '/a2g': {
        target: 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (path) => path.replace(/^\/a2g/, ''),
        configure: (proxy) => proxy.on('proxyReq', (request) => request.removeHeader('origin')),
      },
    },
  },
};
// new A2G({ manifest, url: '/a2g' })
```

The demo shows both: `/` uses its own forward, `/?service=http://127.0.0.1:8787` calls the service directly (start it with `A2G_ALLOWED_ORIGINS=http://127.0.0.1:5180`).

Never put a provider key in a browser build. Shipped browser games need the `client` security profile (join tokens), which the reference service does not implement yet.

## Tests

```sh
npm test   # type check + offline tests; every sent message is validated against the A2G 0.1 JSON Schema
```

The schema is read from a sibling `a2g-protocol` checkout, from `A2G_SCHEMA`, or from https://agent2game.org/schema/0.1/a2g.schema.json.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
