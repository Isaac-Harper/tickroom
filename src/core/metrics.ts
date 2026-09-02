import type { Percentiles } from './types.js';

/** Default capacity for `RollingHistogram`: enough samples to give a stable p95 at a per-second flush cadence without holding an unbounded array in a long-running ticker. */
export const METRIC_CAP = 256;

/**
 * p50/p95/max over `values`, rounded to whole integers (these are timing and
 * byte-size figures destined for a stats gauge or a log line, where
 * sub-integer precision is noise).
 *
 * AN EMPTY WINDOW RETURNS `null`, NOT ZEROS, AND THAT IS THE WHOLE POINT OF
 * THE RETURN TYPE. This used to answer `{ p50: 0, p95: 0, max: 0 }`, on the
 * reasoning that a gauge reading 0 is sortable where a `NaN` is not. For a
 * LATENCY distribution that reasoning is exactly backwards: zero is not a
 * neutral placeholder, it is the BEST POSSIBLE value, so "no samples at all"
 * and "every sample was instantaneous" reported the same three numbers. A
 * room whose every publish was rejected therefore reported
 * `publishAwait {p50:0, p95:0, max:0}`, the healthiest reading the gauge can
 * produce, for the sickest state the room can be in. `null` is the honest
 * answer to a question nothing was measured for, and it is a return type a
 * caller has to acknowledge rather than a value it can quietly plot.
 *
 * Sorts a COPY of `values`: callers routinely hand this the same array they
 * are about to keep pushing into, and sorting in place would silently
 * reorder a caller's own buffer out from under them.
 */
export function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[idx] as number;
  };
  return {
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1] as number),
  };
}

/**
 * A fixed-capacity ring of recent samples for measuring a distribution
 * (tick cadence, publish latency, server-internal processing time) without
 * an ever-growing array. Once full, the OLDEST sample is evicted on each
 * push, so the histogram always reflects a recent window rather than the
 * whole process lifetime, which is what you want for a live health gauge
 * ("is the tick loop healthy right now") rather than a lifetime average
 * that a brief past incident would keep dragging down long after recovery.
 */
export class RollingHistogram {
  private readonly cap: number;
  private readonly values: number[] = [];

  constructor(cap: number = METRIC_CAP) {
    this.cap = cap;
  }

  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.cap) {
      this.values.shift();
    }
  }

  /** `null` while the window is empty: see `percentiles` for why an unmeasured window must not read as a perfect one. */
  percentiles(): Percentiles | null {
    return percentiles(this.values);
  }

  clear(): void {
    this.values.length = 0;
  }

  get length(): number {
    return this.values.length;
  }
}

/**
 * Plain run-scope integer counters (a socket's open/close counts, envelopes
 * dropped, lease renew failures) with a read-and-zero flush, matching the
 * shape a periodic stats publish wants: "how many of this happened since the
 * last time I asked", not a lifetime total a reader has to diff themselves.
 */
export class Counters {
  private readonly values = new Map<string, number>();

  bump(field: string, by: number = 1): void {
    this.values.set(field, (this.values.get(field) ?? 0) + by);
  }

  /** Returns every non-zero-touched field's current value and resets all of them to 0. Fields never bumped since the last flush are omitted, so a stats payload does not grow forever as new counter names accumulate over a process's lifetime. */
  flush(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [field, value] of this.values) {
      out[field] = value;
    }
    this.values.clear();
    return out;
  }

  get(field: string): number {
    return this.values.get(field) ?? 0;
  }
}
