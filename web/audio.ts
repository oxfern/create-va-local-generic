/** Continuous linear resampling; retains phase and boundary samples between worklet blocks. */
export class MonoResampler {
  #position = 0;
  #previous: number | undefined;
  constructor(readonly sourceRate: number, readonly targetRate = 16000) {}
  process(input: Float32Array): Float32Array {
    if (!input.length) return new Float32Array();
    const step = this.sourceRate / this.targetRate;
    const result: number[] = [];
    while (this.#position < input.length - 1) {
      const index = Math.floor(this.#position);
      const fraction = this.#position - index;
      const left = index < 0 ? this.#previous ?? input[0] : input[index];
      const right = input[index + 1];
      result.push(left + (right - left) * fraction);
      this.#position += step;
    }
    this.#position -= input.length;
    this.#previous = input[input.length - 1];
    return Float32Array.from(result);
  }
}

/** Scheduled buffers are bounded; cancellation stops every scheduled source immediately. */
export class PcmPlayer {
  #sources = new Set<AudioBufferSourceNode>();
  #nextTime = 0;
  #quietUntil = 0;
  constructor(readonly context: AudioContext, readonly maxQueuedSeconds = 12) {}
  get active(): boolean { return this.#sources.size > 0; }
  get blocksHandsfree(): boolean { return this.active || this.context.currentTime < this.#quietUntil; }
  play(samples: Float32Array, sampleRate: number): void {
    const start = Math.max(this.context.currentTime + 0.025, this.#nextTime);
    if (start + samples.length / sampleRate - this.context.currentTime > this.maxQueuedSeconds) {
      throw new Error('Audio arrived faster than it could play. Reply stopped; try again.');
    }
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.#sources.add(source);
    source.onended = () => {
      this.#sources.delete(source); source.disconnect();
      this.#quietUntil = this.context.currentTime + 0.35;
    };
    source.start(start);
    this.#nextTime = start + buffer.duration;
  }
  stop(): void {
    if (this.active) this.#quietUntil = this.context.currentTime + 0.35;
    for (const source of this.#sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.#sources.clear();
    this.#nextTime = 0;
  }
}

export function decodePcm(encoded: string): Float32Array {
  const binary = atob(encoded);
  if (binary.length % 4) throw new Error('Invalid PCM audio frame.');
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
  return samples;
}

export function encodePcm(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
  return buffer;
}
