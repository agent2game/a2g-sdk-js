// Game-agnostic A2G protocol 0.1 client for JavaScript and TypeScript (browser and Node). Spec: https://agent2game.org
//
// The game registers one adapter per entity type, tracks its entities and calls execute() for each entity in its
// loop. Real-time games let the client batch requests on its own timers (start()); turn-based or server-side games
// call decideNow() once per turn instead. Any failure means "no decision": execute() returns false and the game
// runs its native AI.

export const PROTOCOL = '0.1';
const PROTOCOL_MAX_BATCH = 16;
const MAX_TELEMETRY_ENTITIES = 128;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fields = Record<string, Json>;
/** A position as [x, y], [x, y, z] or an object with x, y and optional z. */
export type Position = number[] | { x: number; y: number; z?: number };

export interface Adapter<E = any> {
  /** Observation fields declared for the entity type in the manifest. */
  observe(entity: E): Fields;
  /**
   * Actions allowed now. Empty means "do not ask" (observe-only types such as the player). For a type with decision
   * slots: { slot: actions } for the slots to ask; a slot left out (or empty) stays with the native AI.
   */
  legalActions(entity: E): string[] | Record<string, string[]>;
  /**
   * Perform the action for this step. For a type with decision slots, `action` is { slot: action } for the slots A2G
   * decided; run the native AI for every other slot. Return false when it was blocked and the adapter did something safe.
   */
  execute(entity: E, action: any, dt: number): boolean;
  /** Actual executed state, for telemetry. */
  state?(entity: E): string;
  /** Lets the service compute nearby entities and group members. */
  position?(entity: E): Position | null | undefined;
  /** Name of a manifest event that just happened, or "" / undefined. Asks for a decision soon. */
  trigger?(entity: E): string | null | undefined;
  /** Refresh interval in ms (default: the type's refresh_ms, then defaultIntervalMs). */
  intervalMs?(entity: E): number;
  /** Called when native AI takes control back. */
  release?(entity: E): void;
}

export interface ScopeState { scope: string; state?: Fields }

/** Picks one action from provider probabilities; see Options.sample and sampler(). */
export type Sampler = (probabilities: Record<string, number>, context: { entity: unknown; slot?: string }) => string;

/** One decision slot's result from the service: an action, or a fallback code for that slot only. */
export interface SlotResult { action?: string; label?: string; confidence?: number | null; probabilities?: Record<string, number>; code?: string; reason?: string }

/**
 * A sampler driven by the game's own random function (for example a seeded RNG returning [0, 1)), so A2G decisions
 * vary like native AI and replays stay identical.
 */
export function sampler(random: () => number): Sampler {
  return (probabilities) => {
    const entries = Object.entries(probabilities);
    let roll = random() * entries.reduce((sum, [, p]) => sum + p, 0);
    for (const [action, p] of entries) if ((roll -= p) < 0) return action;
    return entries[entries.length - 1][0];
  };
}

export interface Decision {
  source: 'AI' | 'FALLBACK';
  /** The action to execute (sampled when Options.sample is set). */
  action?: string;
  /** Decision slots: the action to execute per decided slot (sampled when Options.sample is set). */
  actions?: Record<string, string>;
  /** Decision slots as the service answered them, including per-slot fallbacks. */
  slots?: Record<string, SlotResult>;
  label?: string;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  decision_id?: string;
  cached?: boolean;
  trigger?: string;
  code?: string;
  reason?: string;
  ttl_ms: number;
  latency_ms: number;
  received_at: number;
}

export interface Options {
  /** The game manifest (the object, for example an imported JSON file). */
  manifest: Record<string, any>;
  /** Decision service base URL. Default http://127.0.0.1:8787. */
  url?: string;
  game?: string;
  engine?: string;
  /** Shared world state. */
  world?: () => Fields;
  /** The active scope and its state, or null. */
  scope?: () => ScopeState | null | undefined;
  /** A paused game sends telemetry but asks for no decisions. */
  paused?: () => boolean;
  /** Scene or level name for telemetry: a string or a function returning the current one. */
  scene?: string | (() => string);
  /** Extra request headers, for example credentials of a future server or client profile. */
  headers?: () => Record<string, string>;
  maxBatch?: number;
  maxInflight?: number;
  batchIntervalMs?: number;
  defaultIntervalMs?: number;
  minIntervalMs?: number;
  telemetryIntervalMs?: number;
  /**
   * Draw each AI action from the provider's probabilities instead of taking the most likely one, so behaviour varies
   * like native AI. Pass sampler(gameRandom) to keep seeded replays identical. Sampling happens on the first execute()
   * of a decision, in the game's own order.
   */
  sample?: Sampler;
  /** Injected for tests or runtimes without a global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds clock. Default performance.now() or Date.now(). */
  now?: () => number;
}

export interface TrackOptions {
  /** Stable entity id. Default: a generated one. */
  id?: string;
  /** Display name for telemetry. */
  name?: string;
  profile?: string;
  /** The group entity (squad, faction, director, leader) or its id. */
  parent?: object | string | null;
}

interface Tracked {
  entity: any;
  id: string;
  type: string;
  name: string;
  profile?: string;
  parent?: string;
  trigger?: string;
  decision?: Decision & { start_observation?: Fields; start_world?: Fields; blocked?: boolean; ran?: boolean; reported?: boolean };
  pending: boolean;
  next: number;
  lastRequest: number;
}

interface Reply { code: number; data: any; headers?: Headers }

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number, digits: number) => Number(value.toFixed(digits));

function scalars(values: Fields): Fields {
  const result: Fields = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value === 'boolean' || typeof value === 'string' || isNumber(value)) result[key] = value;
  }
  return result;
}

function positionArray(value: Position | null | undefined): number[] | undefined {
  if (Array.isArray(value)) return value.length === 2 || value.length === 3 ? value.map((v) => round(v, 1)) : undefined;
  if (isRecord(value) && isNumber(value.x) && isNumber(value.y)) {
    return isNumber(value.z) ? [round(value.x, 1), round(value.y, 1), round(value.z, 1)] : [round(value.x, 1), round(value.y, 1)];
  }
  return undefined;
}

function randomId(): string {
  const crypto = (globalThis as any).crypto;
  return crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class A2G {
  readonly clientId = randomId();
  epoch = 0;
  aiEnabled = false;
  serviceStatus = 'checking';
  sessionReady = false;
  /** 403: the client stops asking until it is recreated. */
  forbidden = false;
  manifestHash = '';
  lastError = '';
  lastAiReplyAt = -1;

  private readonly url: string;
  private readonly manifest: Record<string, any>;
  private readonly options: Options;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly maxBatch: number;
  private readonly maxInflight: number;
  private readonly adapters = new Map<string, Adapter>();
  private readonly byId = new Map<string, Tracked>();
  private readonly byEntity = new WeakMap<object, Tracked>();
  private readonly contextUpdates: { scopes: Record<string, Json>; profiles: Record<string, Json> } = { scopes: {}, profiles: {} };
  private readonly confirmedScopes = new Set<string>();
  private nextId = 1;
  private inflight = 0;
  private backoffUntil = 0;
  private lastSessionAttempt = -Infinity;
  private lastHealthCheck = -Infinity;
  private healthBusy = false;
  private telemetryBusy = false;
  private sessionBusy = false;
  private lastPopulation = -1;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(options: Options) {
    if (!isRecord(options?.manifest)) throw new TypeError('A2G needs the game manifest');
    this.options = options;
    this.manifest = options.manifest;
    this.url = (options.url ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
    const globalFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
    const fetcher = options.fetch ?? globalFetch;
    if (!fetcher) throw new TypeError('No fetch available: pass options.fetch');
    this.fetcher = fetcher;
    const perf = (globalThis as any).performance;
    this.now = options.now ?? (perf?.now ? () => perf.now() : () => Date.now());
    this.maxBatch = Math.min(PROTOCOL_MAX_BATCH, Math.max(1, options.maxBatch ?? PROTOCOL_MAX_BATCH));
    this.maxInflight = Math.max(1, options.maxInflight ?? 2);
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Real-time games: batch decisions and send telemetry on timers. Server games may skip this and call decideNow(). */
  start(): this {
    if (this.timers.length) return this;
    const every = (ms: number, fn: () => unknown) => {
      const timer = setInterval(() => void fn(), ms);
      (timer as any).unref?.();  // never keep a Node process alive
      this.timers.push(timer);
    };
    every(this.options.batchIntervalMs ?? 250, () => this.tick());
    every(this.options.telemetryIntervalMs ?? 1000, () => this.sendTelemetry());
    void this.checkService();
    return this;
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  // --- Registration ------------------------------------------------------------

  registerAdapter<E>(type: string, adapter: Adapter<E>): void {
    this.adapters.set(type, adapter);
  }

  track(entity: object, type: string, options: TrackOptions = {}): string {
    this.untrack(entity);
    const id = options.id ?? `e${this.nextId++}`;
    const tracked: Tracked = { entity, id, type, name: options.name ?? id, profile: options.profile, pending: false, next: 0, lastRequest: -Infinity };
    this.byId.set(id, tracked);
    this.byEntity.set(entity, tracked);
    if (options.parent != null) this.setParent(entity, options.parent);
    return id;
  }

  /** Stop tracking (the entity died or left). Reports its current AI decision first. */
  untrack(entity: object): void {
    const tracked = this.byEntity.get(entity);
    if (!tracked) return;
    this.finish(tracked);
    this.byId.delete(tracked.id);
    this.byEntity.delete(entity);
  }

  /** Link an entity to its group (squad, faction, director or a leader); null unlinks. */
  setParent(entity: object, parent: object | string | null): void {
    const tracked = this.byEntity.get(entity);
    if (!tracked) return;
    tracked.parent = parent == null ? undefined : typeof parent === 'string' ? parent : this.byEntity.get(parent)?.id;
  }

  entityId(entity: object): string | undefined {
    return this.byEntity.get(entity)?.id;
  }

  /** The entity's current decision (AI or FALLBACK), if any. */
  decision(entity: object): Readonly<Decision> | undefined {
    return this.byEntity.get(entity)?.decision;
  }

  // --- Context -----------------------------------------------------------------

  /** Add or replace (object value) or remove (null) scopes and profiles for this session. */
  updateContext(scopes: Record<string, Json> = {}, profiles: Record<string, Json> = {}): void {
    Object.assign(this.contextUpdates.scopes, scopes);
    Object.assign(this.contextUpdates.profiles, profiles);
    if (this.sessionReady) void this.sendContext({ scopes, profiles });
  }

  /** True when decide requests may name this scope: declared in the manifest or accepted through updateContext(). */
  scopeReady(name: string): boolean {
    return (Object.hasOwn(this.manifest.scopes ?? {}, name) && !Object.hasOwn(this.contextUpdates.scopes, name)) || this.confirmedScopes.has(name);
  }

  // --- Mode --------------------------------------------------------------------

  setAiEnabled(on: boolean): void {
    for (const tracked of this.byId.values()) {
      this.finish(tracked);
      if (!on) this.adapters.get(tracked.type)?.release?.(tracked.entity);
      tracked.decision = undefined;
      tracked.pending = false;
      tracked.next = 0;
    }
    this.aiEnabled = on;
    this.epoch += 1;
  }

  // --- Decisions ---------------------------------------------------------------

  /** One batching step. start() calls it every batchIntervalMs; a game may also call it from its own loop. */
  async tick(): Promise<void> {
    if (!(await this.ready())) return;
    const now = this.now();
    const current = this.entities();
    // Someone died or appeared: the situation changed for everyone, so re-decide soon (rate-limited per entity).
    const populationChanged = this.lastPopulation >= 0 && current.length !== this.lastPopulation;
    this.lastPopulation = current.length;
    const minInterval = this.options.minIntervalMs ?? 500;
    for (const tracked of current) {
      let soon = populationChanged;
      const event = this.adapters.get(tracked.type)!.trigger?.(tracked.entity);
      if (event && Object.hasOwn(this.typeSpec(tracked).events ?? {}, event)) {
        tracked.trigger = event;  // the latest event wins until it is sent
        soon = true;
      }
      if (soon) tracked.next = Math.min(tracked.next, tracked.lastRequest + minInterval);
    }
    if (this.inflight >= this.maxInflight || now < this.backoffUntil) return;
    const due = current.filter((tracked) => !tracked.pending && now >= tracked.next);
    await this.send(due.slice(0, this.maxBatch), now, 1);
  }

  /**
   * Turn-based or server-side games: ask for every tracked entity (or the given ones) now and wait for the replies.
   * Batches go out in waves of maxInflight requests, each wave capped at timeoutMs. Entities without a valid reply
   * get a FALLBACK decision, so execute() returns false for them.
   */
  async decideNow(entities?: object[], timeoutMs = 4000): Promise<void> {
    if (!(await this.ready())) return;
    const now = this.now();
    const chosen = entities ? entities.map((entity) => this.byEntity.get(entity)).filter((t): t is Tracked => !!t) : this.entities();
    if (now < this.backoffUntil) return;
    await this.send(chosen.filter((tracked) => !tracked.pending), now, Infinity, timeoutMs);
  }

  /**
   * Call from the entity's update step. Returns true when A2G controls the entity this step;
   * false means the game must run its native AI.
   */
  execute(entity: object, dt: number): boolean {
    const tracked = this.byEntity.get(entity);
    const adapter = tracked && this.adapters.get(tracked.type);
    if (!this.aiEnabled || !tracked || !adapter) return false;
    const decision = tracked.decision;
    if (!decision || !this.isFresh(decision)) {
      this.finish(tracked, true);
      adapter.release?.(entity);
      return false;
    }
    if (!decision.ran) this.choose(tracked, decision);
    decision.ran = true;
    if (!adapter.execute(entity, decision.actions ?? decision.action, dt)) decision.blocked = true;
    return true;
  }

  /** Fix the executed action(s) once: sampled from the probabilities when Options.sample is set, else the service's choice. */
  private choose(tracked: Tracked, decision: NonNullable<Tracked['decision']>): void {
    const sample = this.options.sample;
    const pick = (result: SlotResult, slot?: string) => {
      const legal = slot === undefined ? this.typeSpec(tracked).actions ?? {} : this.typeSpec(tracked).decisions?.[slot]?.actions ?? {};
      const options = Object.entries(result.probabilities ?? {}).filter(([action, p]) => Object.hasOwn(legal, action) && isNumber(p) && p > 0);
      const chosen = sample && options.length ? sample(Object.fromEntries(options), { entity: tracked.entity, slot }) : result.action!;
      return options.some(([action]) => action === chosen) ? chosen : result.action!;
    };
    if (decision.slots) {
      decision.actions = Object.fromEntries(Object.entries(decision.slots).filter(([, r]) => r.action).map(([slot, r]) => [slot, pick(r, slot)]));
    } else {
      decision.action = pick(decision);
    }
  }

  private async ready(): Promise<boolean> {
    if (!this.aiEnabled || this.forbidden || this.options.paused?.()) return false;  // a paused game spends no provider calls
    if (!this.sessionReady) {
      await this.startSession();
      return this.sessionReady;
    }
    return true;
  }

  private entities(): Tracked[] {
    return [...this.byId.values()].filter((tracked) => this.adapters.has(tracked.type));
  }

  private typeSpec(tracked: Tracked): Record<string, any> {
    return this.manifest.entity_types?.[tracked.type] ?? {};
  }

  private isFresh(decision: Decision): boolean {
    return decision.source === 'AI' && this.now() - decision.received_at <= decision.ttl_ms;
  }

  /** Send entities in batches of maxBatch: at most maxRequests batches, in waves of at most maxInflight open requests. */
  private async send(due: Tracked[], now: number, maxRequests: number, timeoutMs = 4000): Promise<void> {
    const batches: [Tracked, Record<string, Json>][][] = [];
    let batch: [Tracked, Record<string, Json>][] = [];
    for (const tracked of due) {
      const request = this.decideEntity(tracked);
      if (!request) continue;
      batch.push([tracked, request]);
      if (batch.length === this.maxBatch) { batches.push(batch); batch = []; }
    }
    if (batch.length) batches.push(batch);
    const chosen = batches.slice(0, maxRequests);
    for (const [tracked] of chosen.flat()) {
      tracked.pending = true;
      tracked.lastRequest = now;
      tracked.trigger = undefined;
    }
    const wave = Math.max(1, this.maxInflight - this.inflight);
    for (let start = 0; start < chosen.length; start += wave) {
      await Promise.all(chosen.slice(start, start + wave).map((batch) => this.decideBatch(batch, now, timeoutMs)));
    }
  }

  /** One decide entity, or null when it should not be asked (observe-only or nothing legal). */
  private decideEntity(tracked: Tracked): Record<string, Json> | null {
    const adapter = this.adapters.get(tracked.type)!;
    const spec = this.typeSpec(tracked);
    const raw = adapter.legalActions(tracked.entity) ?? [];
    let legal: string[] | Record<string, string[]>;
    if (spec.decisions) {
      const slots = Object.entries(isRecord(raw) ? raw : {})
        .map(([slot, actions]) => [slot, (actions ?? []).filter((action: string) => Object.hasOwn(spec.decisions[slot]?.actions ?? {}, action))] as const)
        .filter(([, actions]) => actions.length);
      if (!slots.length) return null;
      legal = Object.fromEntries(slots);
    } else {
      legal = (Array.isArray(raw) ? raw : []).filter((action) => Object.hasOwn(spec.actions ?? {}, action));
      if (!legal.length) return null;
    }
    const request: Record<string, Json> = { id: tracked.id, type: tracked.type, observation: adapter.observe(tracked.entity), legal_actions: legal };
    const where = positionArray(adapter.position?.(tracked.entity));
    if (where) request.position = where;
    if (tracked.profile) request.profile = tracked.profile;
    if (tracked.parent) request.parent = tracked.parent;
    if (tracked.trigger) request.trigger = tracked.trigger;
    return request;
  }

  private async decideBatch(batch: [Tracked, Record<string, Json>][], started: number, timeoutMs: number): Promise<void> {
    this.inflight += 1;
    const requestEpoch = this.epoch;
    const body: Record<string, Json> = { client_id: this.clientId, epoch: requestEpoch, world: this.world(), entities: batch.map(([, request]) => request) };
    const active = this.scope();
    if (active) {
      body.scope = active.scope;
      if (active.state && Object.keys(active.state).length) body.scope_state = active.state;
    }
    let reply: Reply;
    try {
      reply = await this.request('POST', '/v1/decide', body, timeoutMs);
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
    }
    const replies = new Map<string, any>();
    const data = reply.data;
    if (reply.code === 200 && isRecord(data) && data.epoch === requestEpoch && Array.isArray(data.decisions)) {
      for (const decision of data.decisions) if (isRecord(decision)) replies.set(String(decision.id), decision);
    }
    const error = replies.size ? '' : isRecord(data) && 'error' in data ? String(data.error) : 'Decision service unavailable or invalid reply';
    const now = this.now();
    for (const [tracked, request] of batch) {
      if (this.byId.get(tracked.id) !== tracked) continue;  // untracked meanwhile
      tracked.pending = false;
      if (!this.aiEnabled || requestEpoch !== this.epoch) continue;  // stale epoch: drop the reply
      this.finish(tracked);
      const answer = replies.get(tracked.id) ?? {};
      const legal = request.legal_actions as string[] | Record<string, string[]>;
      // Keep only results whose action was offered; a slot that is missing or invalid stays with the native AI.
      const slots = Array.isArray(legal) || !isRecord(answer.slots) ? undefined : Object.fromEntries(Object.entries(answer.slots as Record<string, any>)
        .filter(([slot, r]) => isRecord(r) && (r.action === undefined || legal[slot]?.includes(r.action)) && Object.hasOwn(legal, slot))
        .map(([slot, r]) => [slot, cleanResult(r)]));
      const valid = Array.isArray(legal) ? legal.includes(answer.action) : !!slots && Object.values(slots).some((r) => r.action);
      let decision: NonNullable<Tracked['decision']>;
      if (answer.source === 'AI' && valid && typeof answer.decision_id === 'string') {
        decision = {
          source: 'AI', ...(slots ? { slots } : cleanResult(answer)),
          decision_id: answer.decision_id, cached: answer.cached === true, trigger: (request.trigger as string) ?? '',
          ttl_ms: isNumber(answer.ttl_ms) ? answer.ttl_ms : 12000, latency_ms: now - started, received_at: now,
          // copies: games often mutate one world or observation object in place
          start_observation: { ...(request.observation as Fields) }, start_world: { ...this.world() },
        };
        this.lastAiReplyAt = now;
        this.lastError = '';
      } else {
        decision = { source: 'FALLBACK', code: String(answer.code ?? 'unavailable'), reason: String(answer.reason ?? (error || 'Missing decision')),
          ttl_ms: 0, latency_ms: now - started, received_at: now };
        this.lastError = decision.reason!;
      }
      tracked.decision = decision;
      const adapter = this.adapters.get(tracked.type);
      tracked.next = now + (adapter?.intervalMs?.(tracked.entity) ?? this.typeSpec(tracked).refresh_ms ?? this.options.defaultIntervalMs ?? 3000);
    }
  }

  /**
   * Report the outcome of the entity's current AI decision once: numeric deltas of its observation and the world.
   * `expiring` = its TTL ran out with no new decision. A decision that ran and is replaced or untracked counts as
   * executed even after its TTL, which is the normal case in turn-based games where a turn outlasts the TTL.
   */
  private finish(tracked: Tracked, expiring = false): void {
    const decision = tracked.decision;
    if (decision?.source !== 'AI' || decision.reported) return;
    decision.reported = true;
    const adapter = this.adapters.get(tracked.type);
    const status = decision.blocked ? 'blocked' : !expiring && (decision.ran || this.isFresh(decision)) ? 'executed' : 'expired';
    const outcome: Fields = {};
    if (adapter) addDeltas(outcome, '', decision.start_observation ?? {}, adapter.observe(tracked.entity));
    addDeltas(outcome, 'world_', decision.start_world ?? {}, this.world());
    outcome.seconds = round((this.now() - decision.received_at) / 1000, 1);
    void this.request('POST', '/v1/report', {
      client_id: this.clientId, entity_id: tracked.id, decision_id: decision.decision_id!,
      ...(decision.slots ? { actions: decision.actions ?? Object.fromEntries(Object.entries(decision.slots).filter(([, r]) => r.action).map(([k, r]) => [k, r.action!])) }
        : { action: decision.action! }), status, outcome,
    }, 2000);
  }

  // --- Session and context -----------------------------------------------------

  private async startSession(): Promise<void> {
    if (this.sessionBusy || this.forbidden || this.now() - this.lastSessionAttempt < 3000) return;
    this.sessionBusy = true;
    this.lastSessionAttempt = this.now();
    try {
      const { code, data } = await this.request('POST', '/v1/session', {
        a2g: PROTOCOL, client_id: this.clientId, game: this.options.game ?? 'Web game', engine: this.options.engine ?? defaultEngine(), manifest: this.manifest,
      }, 2000);
      if (code !== 200) {
        this.lastError = 'Session rejected: ' + (isRecord(data) && data.error ? String(data.error) : 'service unavailable');
        return;
      }
      this.manifestHash = String(data?.manifest_hash ?? '');
      this.confirmedScopes.clear();
      const { scopes, profiles } = this.contextUpdates;
      // A new session forgets earlier /v1/context updates: replay them before asking for decisions.
      this.sessionReady = Object.keys(scopes).length || Object.keys(profiles).length ? await this.sendContext(this.contextUpdates) : true;
    } finally {
      this.sessionBusy = false;
    }
  }

  private async sendContext(update: { scopes: Record<string, Json>; profiles: Record<string, Json> }): Promise<boolean> {
    const body: Record<string, Json> = { client_id: this.clientId };
    if (Object.keys(update.scopes).length) body.scopes = update.scopes;
    if (Object.keys(update.profiles).length) body.profiles = update.profiles;
    const { code, data } = await this.request('POST', '/v1/context', body, 2000);
    if (code === 200) {
      for (const [name, value] of Object.entries(update.scopes)) value === null ? this.confirmedScopes.delete(name) : this.confirmedScopes.add(name);
    } else {
      this.lastError = 'Context update rejected: ' + (isRecord(data) && data.error ? String(data.error) : 'service unavailable');
    }
    return code === 200;
  }

  // --- Telemetry and health ----------------------------------------------------

  /** Telemetry for the Agent2Game Console. start() sends it every second, also while paused. */
  async sendTelemetry(): Promise<void> {
    void this.checkService();
    if (this.telemetryBusy) return;
    const now = this.now();
    const items = this.entities().slice(0, MAX_TELEMETRY_ENTITIES).map((tracked) => {
      const adapter = this.adapters.get(tracked.type)!;
      const compact: Fields = {};
      const decision = tracked.decision as Record<string, any> | undefined;
      for (const key of ['source', 'action', 'label', 'confidence', 'code', 'reason', 'latency_ms', 'cached', 'trigger', 'decision_id']) {
        if (decision?.[key] != null && decision[key] !== '') compact[key] = decision[key];
      }
      const executed = decision?.actions ?? (decision?.slots && Object.fromEntries(Object.entries(decision.slots as Record<string, SlotResult>).filter(([, r]) => r.action).map(([k, r]) => [k, r.action!])));
      if (executed) {
        compact.action = Object.entries(executed).map(([slot, action]) => `${slot}=${action}`).join(', ');
        (compact as any).slots = executed;
        delete compact.label;
      }
      if (decision) compact.age_ms = Math.round(now - decision.received_at);
      if (isNumber(compact.latency_ms)) compact.latency_ms = Math.round(compact.latency_ms);
      const item: Fields = { id: tracked.id, type: tracked.type, name: tracked.name, state: adapter.state?.(tracked.entity) ?? '', pending: tracked.pending,
        fields: scalars(adapter.observe(tracked.entity)), decision: this.aiEnabled ? compact : {} };
      const where = positionArray(adapter.position?.(tracked.entity));
      if (where) item.position = where;
      if (tracked.parent) item.parent = tracked.parent;
      if (tracked.profile) item.profile = tracked.profile;
      return item;
    });
    const body: Record<string, Json> = { client_id: this.clientId, mode: this.aiEnabled ? 'ai' : 'native', paused: !!this.options.paused?.(),
      scene: (typeof this.options.scene === 'function' ? this.options.scene() : this.options.scene) ?? 'Game', world: scalars(this.world()), entities: items, last_error: this.lastError };
    const active = this.scope();
    if (active) body.scope = active.scope;
    this.telemetryBusy = true;
    try {
      const { code } = await this.request('POST', '/v1/telemetry', body, 2000);
      if (code !== 200) this.serviceStatus = 'offline';
    } finally {
      this.telemetryBusy = false;
    }
  }

  async checkService(): Promise<void> {
    if (this.healthBusy || this.now() - this.lastHealthCheck < 5000) return;
    this.healthBusy = true;
    this.lastHealthCheck = this.now();
    try {
      const { code, data } = await this.request('GET', '/health', null, 1500);
      if (code === 200 && isRecord(data) && data.service === 'a2g') {
        this.serviceStatus = data.key_configured === true ? 'ready (key configured)' : 'missing API key';
      } else {
        this.serviceStatus = 'offline';
        this.sessionReady = false;
      }
    } finally {
      this.healthBusy = false;
    }
  }

  // --- HTTP --------------------------------------------------------------------

  private world(): Fields {
    return this.options.world?.() ?? {};
  }

  private scope(): ScopeState | null {
    const value = this.options.scope?.();
    return isRecord(value) && typeof value.scope === 'string' && value.scope ? value : null;
  }

  /** Never throws: network errors, timeouts and non-JSON bodies become code 0 / data null. */
  private async request(method: 'GET' | 'POST', path: string, body: Record<string, Json> | null, timeoutMs: number): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reply: Reply = { code: 0, data: null };
    try {
      const response = await this.fetcher(this.url + path, {
        method, signal: controller.signal,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...this.options.headers?.() },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let data = null;
      try { data = text.trim() ? JSON.parse(text) : null; } catch { /* error pages from proxies are expected while a service is down */ }
      reply = { code: response.status, data, headers: response.headers };
    } catch {
      // offline, refused or timed out: no decision, native AI
    } finally {
      clearTimeout(timer);
    }
    this.handleStatus(reply);
    return reply;
  }

  /** Protocol error handling: every non-200 means "no decision" (native AI) plus one reaction. */
  private handleStatus({ code, data, headers }: Reply): void {
    const message = isRecord(data) && data.error ? String(data.error) : '';
    if (code === 401 || code === 409) this.sessionReady = false;  // reopen the session
    if (code === 403) {
      this.forbidden = true;
      this.lastError = 'Forbidden by the service: ' + message;
    }
    if (code === 429) {
      const wait = Math.max(1, parseInt(headers?.get('Retry-After') ?? '', 10) || 5);
      this.backoffUntil = this.now() + wait * 1000;
      this.lastError = `Rate limited; retrying in ${wait} s`;
    }
  }
}

function cleanResult(r: Record<string, any>): SlotResult {
  const result: SlotResult = {};
  if (typeof r.action === 'string') {
    result.action = r.action;
    result.label = String(r.label ?? '');
    result.confidence = isNumber(r.confidence) ? r.confidence : null;
    if (isRecord(r.probabilities)) result.probabilities = Object.fromEntries(Object.entries(r.probabilities).filter(([, p]) => isNumber(p)));
  } else {
    result.code = String(r.code ?? 'invalid_choice');
    result.reason = String(r.reason ?? '');
  }
  return result;
}

function addDeltas(outcome: Fields, prefix: string, before: Fields, after: Fields): void {
  for (const [name, value] of Object.entries(before)) {
    if (Object.keys(outcome).length >= 11) return;  // reports carry at most 12 values, one is "seconds"
    const now = after?.[name];
    if (isNumber(value) && isNumber(now)) outcome[`${prefix}${name}_delta`] = round(now - value, 3);
  }
}

function defaultEngine(): string {
  const nav = (globalThis as any).navigator;
  if (nav?.userAgent && typeof (globalThis as any).document !== 'undefined') return 'Web';
  const version = (globalThis as any).process?.versions?.node;
  return version ? `Node ${version}` : 'JavaScript';
}
