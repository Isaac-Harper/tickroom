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
 * liveness deadline and the lifetime. This file owns exactly the three things
 * that are properties of the SUBSCRIPTION rather than of a socket: delivery,
 * the subscribe acknowledgement, and the probe that says the subscription is
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
 * adapters do (`adapters/node.ts` resolves `hostCreateSubscriber ?? createSubscriber`
 * to the same function object on every connection, and `adapters/vercel.ts`
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
  /** The subscriber emitted `'error'`. Counted, never logged per event: a flapping connection emits them at whatever rate it likes. */
  onSubscriberError(err: unknown): void;
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
  /** True when this member built the subscriber rather than joining one that already existed. */
  readonly created: boolean;
  /** The SUBSCRIBE acknowledgement, shared: a socket attaching mid-subscribe waits on the same promise the first one is racing. */
  ready(): Promise<unknown>;
  /** Starts the self-probe, at the first attaching socket's heartbeat cadence. Idempotent; later members find it already running. */
  startProbing(heartbeatMs: number): void;
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
  private readonly registry: Map<string, RoomSubscriberEntry> | null;
  private readonly key: string;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  // Counted as the NEWEST `n` seen rather than as a tally, so a probe lost on
  // the way out and a probe lost on the way back are the same fact, exactly as
  // in `ticker.ts`.
  private probesSent = 0;
  private probesAnswered = 0;
  private disconnected = false;

  constructor(opts: {
    createSubscriber(): Subscriber;
    redis: RedisLike;
    outChannel: string;
    metaChannel: string;
    probeChannel: string;
    registry: Map<string, RoomSubscriberEntry> | null;
    key: string;
  }) {
    this.redis = opts.redis;
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
        for (const member of this.members) member.onSnapshot(messageBuf);
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
      for (const member of this.members) member.onMeta(text, frame);
    });

    this.sub.on('error', (err: unknown) => {
      for (const member of this.members) member.onSubscriberError(err);
    });
    this.sub.on('end', () => {
      // The connection is gone for good, so no socket this subscription serves
      // will ever receive another snapshot. Retired first, so the next attach
      // for this room builds a fresh subscriber rather than joining a dead one.
      this.retire();
      this.clearProbe();
      for (const member of [...this.members]) member.onSubscriberEnd();
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
    for (const member of [...this.members]) member.onSubscriptionDead(sent, answered);
  }

  private clearProbe(): void {
    if (this.probeTimer === null) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Takes this entry out of the registry so the next attach builds a fresh one. Never disconnects: that is the reference count's job. */
  private retire(): void {
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
  /** This socket's own probe channel. Used only when this socket CREATES the subscription; a socket joining one probes on the channel already in use. */
  probeChannel: string;
  shared: boolean;
  member: RoomSubscriberMember;
}): RoomSubscriptionHandle {
  const { createSubscriber, redis, outChannel, metaChannel, probeChannel, shared, member } = opts;

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

  const created = existing === undefined;
  const entry =
    existing ??
    new RoomSubscriberEntry({ createSubscriber, redis, outChannel, metaChannel, probeChannel, registry, key: outChannel });
  if (created && registry) registry.set(outChannel, entry);
  entry.add(member);

  let released = false;
  return {
    probeChannel: entry.probeChannel,
    created,
    ready: () => entry.ready,
    startProbing: (heartbeatMs: number) => entry.startProbing(heartbeatMs),
    release: () => {
      if (released) return;
      released = true;
      entry.remove(member);
    },
  };
}
