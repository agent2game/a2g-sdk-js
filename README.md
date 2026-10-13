# A2G SDK for JavaScript and TypeScript

Client for the [A2G (Agent2Game) protocol](https://agent2game.org) 0.1 for web and Node games: browser games (Phaser, PixiJS, Three.js, plain canvas) and server-side or turn-based games (Node, Next.js, Deno, Bun). It contains no game-specific code and has no runtime dependencies.

| SDK | Protocol | Runtime |
| --- | --- | --- |
| `0.3.0` | `0.1` | Browsers with `fetch`; Node 22.18+ |

## Install

Not on npm yet. Install from GitHub (the package builds itself on install):

```sh
npm install github:agent2game/a2g-sdk-js#v0.3.0
```

Tags are never moved, but for supply-chain safety you can pin the exact commit a tag points to: `git ls-remote https://github.com/agent2game/a2g-sdk-js v0.3.0` prints it, then `npm install github:agent2game/a2g-sdk-js#<commit>`.

## Demo

A browser page with a player and four guards (plain canvas, no build tools), the same scene as the Godot SDK demo. Start a decision service first, for example the [reference service](https://github.com/agent2game/a2g-service): `docker run -d -p 127.0.0.1:8787:8787 -e OPENAI_API_KEY=... ghcr.io/agent2game/a2g-service:0.1.2` (or `TYPESAFE_API_KEY` with `A2G_PROVIDER=jev`). Then:

```sh
npm ci && npm run build && npm run demo   # http://127.0.0.1:5180/
```

Move with the arrow keys or WASD, hit guards with Space, switch AI mode with the button or `M`. Colors show who controls each guard: blue native AI, green an A2G decision (with its confidence), amber fallback. `demo/serve.mjs` serves the page and forwards `/a2g/v1/*` and `/a2g/health` to the service (`A2G_URL`, default `http://127.0.0.1:8787`) without the browser's `Origin`, as the local profile requires; the session shows up in the Agent2Game Console.

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
await a2g.sendTelemetry();           // after every turn: state changes only on turns
```

Keep the client on the server when the game state must not reach the browser.

## Several choices per turn, and your game's odds

When an entity makes several independent choices at once (how hard to work, whether to help a colleague, whether to ask for a raise), declare [decision slots](https://agent2game.org/specification/manifest/#decision-slots) in the manifest instead of squeezing them into one action:

```ts
a2g.registerAdapter('employee', {
  observe: (p) => ({ workload: p.workloadBand, pay_vs_market: p.payBand }),
  legalActions: (p) => ({                      // slots to ask; leave one out to keep it native
    effort: ['carry_on', 'push_harder', 'reduce_effort'],
    help: p.colleagueOverloaded ? ['none', 'help_colleague'] : [],
    raise: ['none', 'ask_raise'],
  }),
  execute: (p, actions) => applyBehaviours(p, actions), // { effort: 'carry_on', raise: 'none' }; run native AI for missing slots
});
```

The service returns the provider's probabilities with every choice. To keep your game's variety and seeded replays, sample with your own RNG instead of always taking the most likely action:

```ts
import { A2G, sampler } from '@agent2game/a2g';
const a2g = new A2G({ manifest, sample: sampler(game.rng) }); // game.rng(): number in [0, 1)
```

Sampling happens on a decision's first `execute()`, in your loop's order, so replays stay identical. Reports carry the actions the game actually executed.

## Manifest drift checks

Before anything is sent, the SDK checks each observation, the world, the scope state and every legal action against the manifest. A mismatch never reaches the service: that entity stays on native AI (decision code `mismatch`), `lastError` names the field and value, and a warning is printed once per problem. In tests, turn it into a failure:

```ts
const a2g = new A2G({ manifest, strict: true });   // a mismatch throws, so a game change that breaks the integration fails the build
expect(a2g.validate(guard)).toEqual([]);            // or check one entity: ['guard.observation.mood is "furious", not one of "calm", "angry"']
```

See [Keep it in sync](https://agent2game.org/guides/integrate/#keep-it-in-sync).

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

Other calls: `track(entity, type, { id, name, profile, parent })`, `untrack(entity)` (reports the open decision), `setParent(entity, parent)`, `updateContext(scopes, profiles)`, `scopeReady(name)`, `decision(entity)`, `entityId(entity)`, `validate(entity)`, `stop()`. Status fields: `serviceStatus`, `sessionReady`, `lastError`, `epoch`, `forbidden`.

## What it does

Same behavior as the [Godot SDK](https://agent2game.org/implementations/godot-sdk/): opens a session and reopens it after `401`/`409`, replaying context updates; sends up to 16 entities per decide request with at most 2 in flight; re-asks everyone (after at least 500 ms) when the number of tracked entities changes; drops replies from an old epoch, re-checks that the action was offered and has a `decision_id`, expires decisions after `ttl_ms`; reports each finished decision with numeric deltas (a decision that ran counts as `executed` when it is replaced, even if a long turn outlasted its TTL); sends telemetry every second and checks `/health` every 5 s; stops after `403`, waits for `Retry-After` after `429`. Network errors never throw.

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
| `strict` | `false` | Manifest drift checks throw instead of warning (tests, development) |
| `headers` | none | Extra request headers (for future `server`/`client` profile credentials) |
| `fetch`, `now` | globals | Injected for tests |

## Browser games and the local service

The local profile rejects other origins, so a page on `http://localhost:5173` cannot call `http://127.0.0.1:8787` until you list it. Two ways:

1. **List the dev server's origin** (simplest). Start the service with exact loopback origins, comma-separated: `A2G_ALLOWED_ORIGINS=http://localhost:5173`. The service then answers CORS for `/v1/*` and `/health` from those origins only (never `*`, never console routes). Use `new A2G({ manifest, url: 'http://127.0.0.1:8787' })`.
2. **Proxy through the dev server.** The proxy forwards without the browser's `Origin`, so it must first do what the service would: accept only its own loopback `Host` and no foreign `Origin`, and forward only `/v1/*` and `/health`. Otherwise any web page in the browser can reach the service through it. `demo/serve.mjs` is a small example.

The demo shows both: `/` uses its own forward, `/?service=http://127.0.0.1:8787` calls the service directly (start it with `A2G_ALLOWED_ORIGINS=http://127.0.0.1:5180`).

Never put a provider key in a browser build. Shipped browser games need the `client` security profile (join tokens), which the reference service does not implement yet.

## Tests

```sh
npm test   # type check + offline tests; every sent message is validated against the A2G 0.1 JSON Schema
```

The schema is read from a sibling `a2g-protocol` checkout, from `A2G_SCHEMA`, or from https://agent2game.org/schema/0.1/a2g.schema.json.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
