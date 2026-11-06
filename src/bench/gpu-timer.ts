export const TIMER_EXTENSION = 'EXT_disjoint_timer_query_webgl2';
const POOL_SIZE = 4;
const SAMPLE_WINDOW = 30;

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** The subset of WebGL2RenderingContext the timer uses. */
export interface TimerGl {
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
  getExtension(name: string): unknown;
  getParameter(pname: number): unknown;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, pname: number): unknown;
}

/**
 * Measures GPU time per `renderer.render` with TIME_ELAPSED queries. Only one query can be active,
 * so results are polled on later frames from a small pool; disjoint results are dropped.
 */
export class GpuTimer {
  readonly available: boolean;
  private readonly ext: TimerExtension | null;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private readonly samples: number[] = [];
  /** Queries whose result must be dropped: HUD-upload frames and frames from before a reset. */
  private readonly discard = new Set<WebGLQuery>();
  private active: WebGLQuery | null = null;
  private skipNext = false;
  private created = 0;

  constructor(private readonly gl: TimerGl) {
    this.ext = (gl.getExtension(TIMER_EXTENSION) as TimerExtension | null) ?? null;
    this.available = this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active) return;
    this.poll();
    const query = this.acquire();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
    if (this.skipNext) {
      this.discard.add(query);
      this.skipNext = false;
    }
  }

  /** Drops the sample of the next measured frame. */
  excludeNext(): void {
    this.skipNext = true;
  }

  /** Clears samples and discards every result still in flight. */
  reset(): void {
    this.samples.length = 0;
    for (const query of this.pending) this.discard.add(query);
    if (this.active) this.discard.add(this.active);
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Mean GPU ms over recent frames, or null when unavailable or not yet measured. */
  meanMs(): number | null {
    if (this.samples.length === 0) return null;
    return this.samples.reduce((sum, ms) => sum + ms, 0) / this.samples.length;
  }

  dispose(): void {
    for (const query of [...this.free, ...this.pending]) this.gl.deleteQuery(query);
    if (this.active) this.gl.deleteQuery(this.active);
    this.free.length = 0;
    this.pending.length = 0;
    this.discard.clear();
    this.active = null;
  }

  private acquire(): WebGLQuery | null {
    const reused = this.free.pop();
    if (reused) return reused;
    if (this.created >= POOL_SIZE) return null;
    const query = this.gl.createQuery();
    if (query) this.created++;
    return query;
  }

  /**
   * A disjoint flag invalidates every result read in the same poll. Reading the flag clears it,
   * so it is read only once a result is available to consume.
   */
  private poll(): void {
    if (!this.ext) return;
    const first = this.pending[0];
    if (!first || !this.gl.getQueryParameter(first, this.gl.QUERY_RESULT_AVAILABLE)) return;
    const disjoint = Boolean(this.gl.getParameter(this.ext.GPU_DISJOINT_EXT));
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!query || !this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) return;
      this.pending.shift();
      const dropped = this.discard.delete(query);
      if (!disjoint && !dropped) {
        const ns = Number(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT));
        this.samples.push(ns / 1e6);
        if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
      }
      this.free.push(query);
    }
  }
}
