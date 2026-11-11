/**
 * A fake `AudioContext` for the mixer's unit tests (P6.5): nodes record their connections and
 * disconnects, params evaluate their automation at any time, sources end when the clock passes
 * their stop time or their buffer's end, and `advance` moves the clock.
 */
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioListenerLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceLike,
  CompressorNodeLike,
  GainNodeLike,
  PannerNodeLike,
} from '../src/audio/context.ts';

type ParamEvent =
  | { kind: 'set'; v: number; t: number }
  | { kind: 'linear'; v: number; t: number }
  | { kind: 'target'; v: number; t: number; tau: number };

export class FakeParam implements AudioParamLike {
  events: ParamEvent[] = [];
  private base: number;
  constructor(
    private readonly ctx: FakeAudioContext,
    initial: number,
  ) {
    this.base = initial;
  }
  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }
  set value(v: number) {
    this.events = [];
    this.base = v;
  }
  private push(event: ParamEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.t - b.t);
  }
  setValueAtTime(v: number, t: number): this {
    this.push({ kind: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.push({ kind: 'linear', v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    this.push({ kind: 'target', v, t, tau });
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** The automated value at time `t`. */
  valueAt(t: number): number {
    let v = this.base;
    let vt = 0;
    let target: { v: number; tau: number; t0: number; v0: number } | null = null;
    const at = (time: number): number =>
      target ? target.v + (target.v0 - target.v) * Math.exp(-(time - target.t0) / target.tau) : v;
    for (const e of this.events) {
      if (e.t > t) {
        if (e.kind === 'linear') {
          const v0 = at(vt);
          return e.t === vt ? e.v : v0 + ((e.v - v0) * (t - vt)) / (e.t - vt);
        }
        break;
      }
      if (e.kind === 'target') {
        const v0 = at(e.t);
        target = { v: e.v, tau: e.tau, t0: e.t, v0 };
      } else {
        v = e.v;
        target = null;
      }
      vt = e.t;
    }
    return at(t);
  }
}

export class FakeNode implements AudioNodeLike {
  outputs: FakeNode[] = [];
  /** Every node this one was ever connected to. */
  connectedTo: FakeNode[] = [];
  disconnects = 0;
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect(destination: AudioNodeLike): AudioNodeLike {
    const node = destination as FakeNode;
    this.outputs.push(node);
    this.connectedTo.push(node);
    return destination;
  }
  disconnect(): void {
    this.outputs = [];
    this.disconnects++;
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'gain');
    this.gain = new FakeParam(ctx, 1);
  }
}

export class FakeCompressor extends FakeNode implements CompressorNodeLike {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'compressor');
    this.threshold = new FakeParam(ctx, -24);
    this.knee = new FakeParam(ctx, 30);
    this.ratio = new FakeParam(ctx, 12);
    this.attack = new FakeParam(ctx, 0.003);
    this.release = new FakeParam(ctx, 0.25);
  }
}

export class FakePanner extends FakeNode implements PannerNodeLike {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX: FakeParam;
  readonly positionY: FakeParam;
  readonly positionZ: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'panner');
    this.positionX = new FakeParam(ctx, 0);
    this.positionY = new FakeParam(ctx, 0);
    this.positionZ = new FakeParam(ctx, 0);
  }
  get position(): [number, number, number] {
    return [this.positionX.value, this.positionY.value, this.positionZ.value];
  }
}

export class FakeBuffer implements AudioBufferLike {
  constructor(readonly duration: number) {}
}

export class FakeSource extends FakeNode implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  startedAt: number | null = null;
  offset = 0;
  stopAt: number | null = null;
  ended = false;
  onended: ((this: never, event: Event) => unknown) | null = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'source');
  }
  start(when = this.ctx.currentTime, offset = 0): void {
    if (this.startedAt !== null) throw new Error('start twice');
    this.startedAt = when;
    this.offset = offset;
  }
  stop(when = this.ctx.currentTime): void {
    this.stopAt = when;
  }
  /** When the source ends on its own or by its stop. */
  endTime(): number {
    if (this.startedAt === null) return Number.POSITIVE_INFINITY;
    const natural =
      this.loop || !this.buffer
        ? Number.POSITIVE_INFINITY
        : this.startedAt + this.buffer.duration - this.offset;
    return Math.min(natural, this.stopAt ?? Number.POSITIVE_INFINITY);
  }
}

class FakeListener implements AudioListenerLike {
  readonly positionX: FakeParam;
  readonly positionY: FakeParam;
  readonly positionZ: FakeParam;
  readonly forwardX: FakeParam;
  readonly forwardY: FakeParam;
  readonly forwardZ: FakeParam;
  readonly upX: FakeParam;
  readonly upY: FakeParam;
  readonly upZ: FakeParam;
  constructor(ctx: FakeAudioContext) {
    this.positionX = new FakeParam(ctx, 0);
    this.positionY = new FakeParam(ctx, 0);
    this.positionZ = new FakeParam(ctx, 0);
    this.forwardX = new FakeParam(ctx, 0);
    this.forwardY = new FakeParam(ctx, 0);
    this.forwardZ = new FakeParam(ctx, -1);
    this.upX = new FakeParam(ctx, 0);
    this.upY = new FakeParam(ctx, 1);
    this.upZ = new FakeParam(ctx, 0);
  }
}

/** Bytes whose decoded duration is `seconds` (100 bytes per second). */
export const audioBytes = (seconds: number): ArrayBuffer =>
  new ArrayBuffer(Math.round(seconds * 100));

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  state = 'running';
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  readonly listener = new FakeListener(this);
  decodes = 0;
  constructor() {
    this.destination = new FakeNode(this, 'destination');
  }
  createGain(): FakeGain {
    return new FakeGain(this);
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }
  createPanner(): FakePanner {
    return new FakePanner(this);
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }
  /** Audio-clock seconds each decode takes: the clock advances by it before the decode resolves. */
  decodeDelayS = 0;
  /** When set, every decode resolves only after it does. */
  decodeGate: Promise<void> | null = null;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodes++;
    if (data.byteLength === 0) return Promise.reject(new Error('EncodingError'));
    const buffer = new FakeBuffer(data.byteLength / 100);
    if (this.decodeGate) return this.decodeGate.then(() => buffer);
    if (this.decodeDelayS <= 0) return Promise.resolve(buffer);
    return Promise.resolve().then(() => {
      this.advance(this.decodeDelayS);
      return buffer;
    });
  }
  /** When set, suspend and resume change the state only after it resolves. */
  stateGate: Promise<void> | null = null;
  /**
   * Resumes still to refuse, as a gesture without user activation does in Chrome: the state stays
   * as it was and the promise never settles.
   */
  resumeRefusals = 0;
  resumes = 0;
  async resume(): Promise<void> {
    this.resumes++;
    if (this.resumeRefusals > 0) {
      this.resumeRefusals--;
      return new Promise<void>(() => {});
    }
    if (this.stateGate) await this.stateGate;
    if (this.state !== 'closed') this.state = 'running';
  }
  async suspend(): Promise<void> {
    if (this.stateGate) await this.stateGate;
    if (this.state !== 'closed') this.state = 'suspended';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  /** Moves the clock and ends every source whose end has passed. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (!(node instanceof FakeSource) || node.ended) continue;
      if (node.endTime() <= this.currentTime + 1e-9) {
        node.ended = true;
        node.onended?.call(undefined as never, new Event('ended'));
      }
    }
  }
  sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  }
  /** Sources started and not yet ended. */
  live(): FakeSource[] {
    return this.sources().filter((s) => s.startedAt !== null && !s.ended);
  }
}

/** The chain of nodes from `node` to the destination, following each node's first output. */
export function chain(node: FakeNode): FakeNode[] {
  const out: FakeNode[] = [node];
  let n = node;
  while (n.outputs.length > 0 && out.length < 16) {
    n = n.outputs[0];
    out.push(n);
  }
  return out;
}

/** Lets pending promises (fetch, decode) settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
