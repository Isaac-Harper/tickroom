import type { RedisLike } from '../core/index.js';
import type { Subscriber } from './redis.js';

/**
 * ONE SUBSCRIBER PER ROOM PER PROCESS, reference counted, shared by every
 * socket in that process attached to that room.
 *
 * WHAT THIS FILE IS FOR, MEASURED. `attachRelay` used to open its own
 * subscriber connection per SOCKET, so a room's snapshot crossed Redis once
 * per player: one publish, N deliveries. Measured on a hundred-seat room over
 * 63 seconds, 2.9 MB published came back as 283 MB of Redis egress and 103
 * concurrent client connections, which is 16 GB an hour for ONE room and one
 * percent of a default `maxclients` spent on a single arena. The fan-out is
 * also quadratic in the room's population, because the frame itself is linear
 * in it: five times the sockets cost eleven times the bytes.
 *
 * None of that is inherent. Every socket in one process subscribed to the same
 * two channels and received byte-identical payloads; the only thing each one
 * did differently was decide whether ITS transport was backed up. So the
 * subscription is shared and the fan-out happens in process: Redis delivers a
 * snapshot once per process, and this file hands the same `Buffer` to each
 * member, which keeps its own send accounting. The connection count per
 * process falls from sockets to rooms.
 *
 * WHAT IS NOT SHARED, and the list is deliberately short. Everything the relay
 * does that depends on WHICH socket it is holding stays per socket: the join
 * heartbeat, the playout depth frame, the snapshot backlog drop (a slow socket
 * must not stall its neighbours), the inbound rate limit, the ticker check, the
 * liveness deadline and the lifetime. This file owns exactly the things that
 * are properties of the SUBSCRIPTION rather than of a socket: delivery, the
 * subscribe acknowledgement and the resubscribe after a reconnect, the count of
 * the connection's own errors, and the probe that says the subscription is
 * still alive.
 *
 * THE REGISTRY IS KEYED ON THE SUBSCRIBER FACTORY AS WELL AS THE ROOM, and
 * that is not defensive tidiness. `createSubscriber` is the only thing that
 * says WHICH Redis a subscription is pointed at: two relays built from two
 * different factories (two `createMemoryRedis()` stores, a test's own fake, a
 * host holding two buses) share a room id and share nothing else, and handing
 * the second one the first one's subscriber is a room whose snapshots come
 * from a bus nobody in it publishes to. A `WeakMap` on the factory makes that
 * structurally impossible and costs nothing in a deployment, where the factory
 * is a module binding.
 *
 * THE CONSEQUENCE FOR A HOST IS ONE LINE: PASS A STABLE FACTORY. Both shipped
 * adapters do (`adapters/node.ts` hands over the host's injected factory or the
 * default module's, the same function object on every connection, and `adapters/vercel.ts`
 * passes the module's own import), so nothing has to change to get the sharing.
 * A host that builds a FRESH closure per socket (`createSubscriber: () => makeOne()`
 * written inside the connection handler) gets one subscriber per socket exactly
 * as before: the sharing degrades to the old behaviour rather than to the wrong
 * bus, which is the failure direction worth having.
 */

/**
 * How many probes may go unanswered before the subscription is declared dead.
 * Three, so a single dropped delivery (or a probe published into a momentarily
 * unreachable Redis) is never enough on its own, and paced by the relay's
 * HEARTBEAT rather than by a knob of its own: the heartbeat is already the one
 * cadence the client cannot influence, and giving liveness a second,
 * independent period is how `ticker.ts` ended up with a deadline derived from a
 * metrics setting.
 */
export const PROBE_MISS_LIMIT = 3;

/** A control frame off the roster channel, parsed ONCE for the whole room rather than once per socket. */
export interface MetaFrame {
  t?: unknown;
  pid?: unknown;
  c?: unknown;
}

/**
 * Turns the raw `keys.meta` hash into the shape a roster seed is built from:
 * one parsed, well-formed record per pid. Shared by the per-socket seed
 * (`relay.ts`'s `seedRoster`, which still does its own `HGETALL` for a join
 * or a subscribe ack) and the resubscribe path below, which reads the hash
 * ONCE for the whole room rather than once per socket.
 *
 * `Object.create(null)`, NOT `{}`, AND THE REASON IS A HASH FIELD NAME. The
 * keys here are pids, which come from a host's own identity system, and
 * `map[k] = ...` on an object literal with `k` of `__proto__` REPARENTS the
 * object instead of adding a property: the entry then vanishes from
 * `JSON.stringify`, so that player is missing from the seed while the
 * ticker's own broadcast (built with `Object.fromEntries`, which has no such
 * rule) does include them. A null-prototype object has no `__proto__`
 * setter, so the assignment is an ordinary own property and serialises.
 */
export function parseRosterHash(raw: Record<string, string>): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    try {
      const parsed: unknown = JSON.parse(v);
      // The ticker writes `env.meta ?? {}`, so every legitimate entry is a
      // plain object. Anything else in this hash was not written by the
      // roster path, and a scalar or an array reaching a host formatter that
      // expects a record is a crash in the host's code rather than a seed.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      map[k] = parsed;
    } catch {
      // a corrupt single field must not blank the whole seed
    }
  }
  return map;
}

/**
 * One socket's half of a shared subscription. Every method is called
 * synchronously from a Redis delivery or a timer, so each one must behave the
 * way the relay's own message path does: cheap, never throwing, and guarded
 * against its own socket already having closed.
 */
export interface RoomSubscriberMember {
  /** A snapshot off `keys.out`. The SAME `Buffer` every member is handed, so nobody may mutate it. */
  onSnapshot(payload: Buffer): void;
  /** A frame off `keys.metaout`, with the one JSON parse already done, or `null` for anything that is not an object. */
  onMeta(text: string, frame: MetaFrame | null): void;
  /**
   * The subscriber came back from a reconnect and its channels are subscribed
   * again. Anything published on `keys.metaout` while it was down reached
   * nobody, and a roster change is announced exactly once, so the member
   * re-seeds its socket's roster. The `HGETALL` behind this is read ONCE for
   * the whole subscription (see `parseRosterHash`) rather than once per
   * member, so the parsed roster arrives as an argument instead of each
   * member fetching its own.
   */
  onResubscribed(roster: Record<string, unknown>): void;
  /** The subscriber emitted `'end'`, i.e. the connection is gone for good. */
  onSubscriberEnd(): void;
  /** `PROBE_MISS_LIMIT` probes went unanswered: this subscription no longer delivers anything to anyone. */
  onSubscriptionDead(sent: number, answered: number): void;
}

export interface RoomSubscriptionHandle {
  /**
   * The channel this subscription probes itself on. It is the channel of
   * whichever socket CREATED the subscription, which is what keeps it
   * addressable from the join envelope's `c` exactly as the per-socket version
   * always was; see `probeChannel` in `relay.ts` for why the name is shaped
   * that way and why the answer is bounded by what was actually sent.
   */
  readonly probeChannel: string;
  /** The SUBSCRIBE acknowledgement, shared: a socket attaching mid-subscribe waits on the same promise the first one is racing. */
  ready(): Promise<unknown>;
  /** Starts the self-probe, at the first attaching socket's heartbeat cadence. Idempotent; later members find it already running. */
  startProbing(heartbeatMs: number): void;
  /**
   * The subscriber `'error'` events since the last call, and the newest one,
   * or `null` when there were none. Counted ONCE for the subscription and
   * taken by whichever member flushes first, so one error on a connection that
   * serves twenty sockets is one count on one line, not twenty lines.
   */
  takeErrors(): { count: number; error: string } | null;
  /**
   * Takes the subscription out of the registry so the next socket for this
   * room builds a fresh one. For a subscribe that never acknowledged: the
   * members already holding it keep their reference, and the subscriber is
   * still disconnected when the last of them goes.
   */
  retire(): void;
  /** Drops this member. The subscriber is disconnected when the last one goes. Idempotent. */
  release(): void;
}

/**
 * Per subscriber factory, the rooms this process currently holds a
 * subscription for. `WeakMap` rather than `Map` so a factory that goes out of
 * scope (a test's own fake, a host that tears a server down and builds
 * another) takes its registry with it instead of pinning every room it ever
 * opened.
 */
const registries = new WeakMap<object, Map<string, RoomSubscriberEntry>>();

class RoomSubscriberEntry {
  readonly sub: Subscriber;
  readonly members = new Set<RoomSubscriberMember>();
  readonly ready: Promise<unknown>;
  readonly probeChannel: string;
  private readonly redis: RedisLike;
  private readonly metaKey: string;
  private readonly registry: Map<string, RoomSubscriberEntry> | null;
  private readonly key: string;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  // Counted as the NEWEST `n` seen rather than as a tally, so a probe lost on
  // the way out and a probe lost on the way back are the same fact, exactly as
  // in `ticker.ts`.
  private probesSent = 0;
  private probesAnswered = 0;
  private disconnected = false;
  private acknowledged = false;
  private errorCount = 0;
  private lastError: string | null = null;

  constructor(opts: {
    createSubscriber(): Subscriber;
    redis: RedisLike;
    outChannel: string;
    metaChannel: string;
    metaKey: string;
    probeChannel: string;
    registry: Map<string, RoomSubscriberEntry> | null;
    key: string;
  }) {
    this.redis = opts.redis;
    this.metaKey = opts.metaKey;
    this.probeChannel = opts.probeChannel;
    this.registry = opts.registry;
    this.key = opts.key;
    this.sub = opts.createSubscriber();

    // ONE listener, on the buffer-preserving event, for all three channels.
    // Snapshots (`keys.out`) must never be decoded to a JS string: a binary
    // codec run through ioredis's string-decoding `message` event is corrupted
    // by the lossy round trip. Roster and control traffic (`keys.metaout`) is
    // always JSON text this library itself publishes, so it is decoded here,
    // ONCE for the whole room rather than once per socket, and forwarded as a
    // string, which is what makes the client receive it as a TEXT frame rather
    // than a binary one.
    this.sub.on('messageBuffer', (channelBuf: unknown, messageBuf: unknown) => {
      if (!Buffer.isBuffer(messageBuf)) return;
      const channel = Buffer.isBuffer(channelBuf) ? channelBuf.toString('utf8') : String(channelBuf);
      if (channel === opts.outChannel) {
        // ITERATED LIVE, WHICH IS SAFE AND IS THE POINT. A send that throws
        // can take its own socket down inside this loop and remove that member
        // from the set; a `Set` iteration skips a member deleted before it is
        // reached, which is exactly the right answer, and copying the set per
        // snapshot would allocate once a tick per room for nothing.
        for (const member of this.members) {
          try {
            member.onSnapshot(messageBuf);
          } catch {
            // see `deliverEach`
          }
        }
        return;
      }
      if (channel === this.probeChannel) {
        this.noteProbeAnswer(messageBuf);
        return;
      }
      if (channel !== opts.metaChannel) return;
      const text = messageBuf.toString('utf8');
      // THE PARSE IS THE SHARED PART AND THE DECISION IS NOT. Which frames may
      // reach a socket, which pid a `room-reject` names and which buffer depth
      // belongs to which player are all per-socket answers the relay keeps;
      // turning the bytes into an object is the same work for every one of
      // them, and used to be paid once per socket per frame.
      let frame: MetaFrame | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) frame = parsed as MetaFrame;
      } catch {
        // Not JSON at all, so it is not a frame this library owns. The relay
        // forwards it verbatim: the roster channel is the seam a host's own
        // control traffic rides.
      }
      this.deliverEach((member) => member.onMeta(text, frame));
    });

    // COUNTED ON THE SUBSCRIPTION, NOT ON EVERY SOCKET IT SERVES. One event on
    // one connection is one fact, and pushing it into every member's counter
    // turned a flapping subscriber into a line per socket per beat.
    this.sub.on('error', (err: unknown) => {
      this.errorCount++;
      this.lastError = String(err);
    });
    // A READY AFTER THE FIRST ACKNOWLEDGEMENT IS A RECONNECT, and the
    // acknowledgement every member waited on says nothing about it. ioredis
    // resubscribes on its own, but whatever was published on the roster
    // channel while the connection was down reached nobody. So the channels
    // are subscribed again HERE, and only once that is acknowledged is every
    // member told to re-read the roster: the same subscribe-then-read order
    // that makes the per-socket seed race-free (see the ack in `relay.ts`).
    // Subscribing a channel twice is idempotent in Redis, so racing ioredis's
    // own resubscribe costs one redundant reply. A ready before the first
    // acknowledgement is the initial connect, which the members' own ack
    // already covers.
    this.sub.on('ready', () => {
      if (!this.acknowledged || this.disconnected) return;
      this.sub
        .subscribe(opts.outChannel, opts.metaChannel, opts.probeChannel)
        .then(() =>
          // THE ROSTER HASH IS READ ONCE FOR THE SUBSCRIPTION, NOT ONCE PER
          // MEMBER. A room with a hundred sockets used to run a hundred
          // `HGETALL`s against the same key on every bus reconnect; the
          // result is the same for all of them, so it is fetched here and
          // handed to each member, the same split `onMeta`'s single parse
          // already makes between shared work and per-socket decision.
          this.redis.hgetall(this.metaKey).then((raw) => {
            // A COPY EACH, null-prototype like the original (see
            // `parseRosterHash`), so a host formatter that edits its map
            // cannot change the roster the next member is seeded with.
            const roster = parseRosterHash(raw);
            this.deliverEach((member) =>
              member.onResubscribed(Object.assign(Object.create(null) as Record<string, unknown>, roster))
            );
          })
        )
        .catch((err: unknown) => {
          // Either the resubscribe itself dropped before it landed (the next
          // ready runs this again, and a connection that never comes back is
          // the probe's to catch) or the roster read failed on an otherwise
          // live connection. One line for the subscription either way, not
          // one per member: the same consolidation the `'error'` listener
          // above makes.
          this.errorCount++;
          this.lastError = String(err);
        });
    });
    this.sub.on('end', () => {
      // The connection is gone for good, so no socket this subscription serves
      // will ever receive another snapshot. Retired first, so the next attach
      // for this room builds a fresh subscriber rather than joining a dead one.
      this.retire();
      this.clearProbe();
      this.deliverEach((member) => member.onSubscriberEnd(), true);
    });

    this.ready = this.sub.subscribe(opts.outChannel, opts.metaChannel, opts.probeChannel).catch((err: unknown) => {
      // A subscribe that never landed is a subscription that never existed.
      // Every member racing this promise closes its own socket with
      // `relayUnavailable` and reconnects onto a fresh relay; retiring here is
      // what makes sure the fresh one does not find this corpse in the
      // registry and join it.
      this.retire();
      throw err;
    });
    this.ready.then(
      () => {
        this.acknowledged = true;
      },
      () => {}
    );
  }

  takeErrors(): { count: number; error: string } | null {
    if (this.errorCount === 0) return null;
    const taken = { count: this.errorCount, error: this.lastError ?? '' };
    this.errorCount = 0;
    this.lastError = null;
    return taken;
  }

  add(member: RoomSubscriberMember): void {
    this.members.add(member);
  }

  remove(member: RoomSubscriberMember): void {
    this.members.delete(member);
    if (this.members.size > 0) return;
    // THE LAST SOCKET OUT TURNS THE LIGHT OFF, with the same close discipline
    // the per-socket path had: a `disconnect()` that throws must never escape
    // into a socket's own close handling.
    this.retire();
    this.clearProbe();
    if (this.disconnected) return;
    this.disconnected = true;
    try {
      this.sub.disconnect();
    } catch {
      // best-effort teardown only
    }
  }

  /**
   * THE SUBSCRIPTION PROBES ITSELF, because nothing else in the system can see
   * it die. A subscriber connection that is BLACK-HOLED (a dropped NAT mapping,
   * a firewall that discards packets with no FIN and no RST) stays OPEN as far
   * as both ends are concerned: ioredis never reconnects, so `'end'` never
   * fires and the resubscribe never happens, and the relay's own liveness check
   * measures only what the CLIENT sends, so a perfectly healthy, chatty player
   * keeps the socket alive forever while receiving nothing. Measured against
   * real ioredis behind a black-holing proxy: zero frames after two seconds, no
   * log line, no close. The only way to learn that a channel still delivers is
   * to send something down it and watch for it coming back.
   *
   * ONE PROBE FOR ALL OF THE SOCKETS IT SERVES, which is the same economy the
   * sharing exists for: the probe answers "does THIS SUBSCRIBER still deliver",
   * and there is now one of those per room per process rather than one per
   * socket. When it fails, every socket the subscription serves is dropped, the
   * same way a dead private subscription dropped its one socket.
   *
   * The cadence is the FIRST attaching socket's `heartbeatMs`. In a deployment
   * that value comes from one place for every socket in the process, and a
   * period that changed under a subscription as sockets came and went would be
   * a deadline nobody could state.
   */
  startProbing(heartbeatMs: number): void {
    if (this.probeTimer !== null || this.disconnected) return;
    this.probeTimer = setInterval(() => {
      // Checked BEFORE the next probe is published, so the deadline is three
      // unanswered probes plus the beat that notices. Fire-and-forget with a
      // bare `.catch`, because a probe that could not even be PUBLISHED is an
      // unanswered probe, which is the correct reading rather than a special
      // case: the subscription cannot serve its sockets either way.
      if (this.probesSent - this.probesAnswered >= PROBE_MISS_LIMIT) {
        this.declareDead();
        return;
      }
      this.probesSent++;
      this.redis.publish(this.probeChannel, JSON.stringify({ t: 'probe', n: this.probesSent })).catch(() => {});
    }, heartbeatMs);
  }

  private noteProbeAnswer(messageBuf: Buffer): void {
    // THIS SUBSCRIPTION'S OWN PROBE, COMING BACK. It is never forwarded to any
    // socket and never counted as traffic: it is not a frame, it is the answer
    // to "does my subscription still deliver anything at all".
    try {
      const answer = JSON.parse(messageBuf.toString('utf8')) as { n?: unknown };
      // BOUNDED BY WHAT WAS ACTUALLY SENT, not merely monotonic. The channel
      // name contains the creating socket's `conn`, which the relay publishes
      // in the clear on every join envelope, so anyone who can write to the bus
      // can address it: a single forged `{ t: 'probe', n: 1e15 }` against an
      // unbounded `n > probesAnswered` check disables the watchdog for the rest
      // of the subscription's life (measured: the control terminated with one
      // dead line, the poisoned one never terminated across ten seconds of
      // heartbeats). An answer for a probe that was never sent is not an
      // answer, and `<= probesSent` caps the damage of a forgery at the current
      // beat. `isInteger` refuses the `1e999`/`NaN` shapes a hand-built frame
      // can carry, exactly like the pong echo's own validation.
      const n = answer.n;
      if (typeof n === 'number' && Number.isInteger(n) && n > this.probesAnswered && n <= this.probesSent) {
        this.probesAnswered = n;
      }
    } catch {
      // Nothing else publishes here, so a frame that does not parse is not an
      // answer; the deadline treats it as the silence it is.
    }
  }

  private declareDead(): void {
    this.retire();
    this.clearProbe();
    const sent = this.probesSent;
    const answered = this.probesAnswered;
    // COPIED, unlike the snapshot loop: every member is about to close, which
    // drains the set this is walking, and a member that never got told would
    // hold an open socket onto a subscription that delivers nothing.
    this.deliverEach((member) => member.onSubscriptionDead(sent, answered), true);
  }

  /**
   * ONE MEMBER'S THROW STOPS NOTHING ELSE. Every member call runs host code
   * (a logger, a formatter, a socket send), and an unguarded throw in this
   * loop skipped every member after it and escaped into ioredis's reply
   * parser or a timer. `copy` for the loops whose members close, and so
   * drain the set being walked.
   */
  private deliverEach(deliver: (member: RoomSubscriberMember) => void, copy = false): void {
    for (const member of copy ? [...this.members] : this.members) {
      try {
        deliver(member);
      } catch {
        // the member's own socket is the only one that pays for it
      }
    }
  }

  private clearProbe(): void {
    if (this.probeTimer === null) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Takes this entry out of the registry so the next attach builds a fresh one. Never disconnects: that is the reference count's job. */
  retire(): void {
    if (this.registry?.get(this.key) === this) this.registry.delete(this.key);
  }
}

/**
 * Joins this socket to its room's subscription, building one if this is the
 * first socket for that room in this process.
 *
 * `shared: false` is the escape hatch: it builds a subscription this socket
 * alone holds, which is the pre-1.1 behaviour byte for byte (its own
 * connection, its own probe channel, its own `'end'`). See `sharedSubscriber`
 * in `RelayOptions` for when that is the right answer.
 */
export function acquireRoomSubscription(opts: {
  createSubscriber(): Subscriber;
  redis: RedisLike;
  outChannel: string;
  metaChannel: string;
  /** `keys.meta`, the hash the resubscribe path reads once for the whole room to re-seed every member's roster. */
  metaKey: string;
  /** This socket's own probe channel. Used only when this socket CREATES the subscription; a socket joining one probes on the channel already in use. */
  probeChannel: string;
  shared: boolean;
  member: RoomSubscriberMember;
}): RoomSubscriptionHandle {
  const { createSubscriber, redis, outChannel, metaChannel, metaKey, probeChannel, shared, member } = opts;

  let registry: Map<string, RoomSubscriberEntry> | null = null;
  let existing: RoomSubscriberEntry | undefined;
  if (shared) {
    const factoryKey = createSubscriber as unknown as object;
    registry = registries.get(factoryKey) ?? null;
    if (!registry) {
      registry = new Map<string, RoomSubscriberEntry>();
      registries.set(factoryKey, registry);
    }
    // Keyed on the SNAPSHOT channel, which already carries the namespace and
    // the room id and is therefore the one string that says "this room on this
    // deployment" without restating either.
    existing = registry.get(outChannel);
  }

  const entry =
    existing ??
    new RoomSubscriberEntry({
      createSubscriber,
      redis,
      outChannel,
      metaChannel,
      metaKey,
      probeChannel,
      registry,
      key: outChannel,
    });
  if (existing === undefined && registry) registry.set(outChannel, entry);
  entry.add(member);

  let released = false;
  return {
    probeChannel: entry.probeChannel,
    ready: () => entry.ready,
    startProbing: (heartbeatMs: number) => entry.startProbing(heartbeatMs),
    takeErrors: () => entry.takeErrors(),
    retire: () => entry.retire(),
    release: () => {
      if (released) return;
      released = true;
      entry.remove(member);
    },
  };
}
