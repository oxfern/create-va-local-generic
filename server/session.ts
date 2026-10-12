import systemPrompt from "./prompt.md" with { type: "text" };
import type { ChatMessage, LanguageModel } from "./llama";
export interface Speech { transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>; synthesize(text: string, signal: AbortSignal): Promise<{ samples: string; sampleRate: number }> }
export type Event = { type: string; turnId?: number; [key: string]: unknown };
export class VoiceSession {
 #turnId = 0;
 #controller = new AbortController();
 #chunks: Float32Array[] = [];
 #sampleCount = 0;
 #listening = false;
 #history: ChatMessage[] = [];
 #closed = false;
 constructor(readonly model: LanguageModel, readonly speech: Speech, readonly send: (event: Event) => void, readonly historyBudget = 10000) {}
 #emit(event: Event) { if (!this.#closed) this.send(event); }
 interrupt() {
  const oldTurn = this.#turnId;
  this.#controller.abort();
  this.#controller = new AbortController();
  this.#turnId++;
  this.#chunks = []; this.#sampleCount = 0; this.#listening = false;
  this.#emit({ type: "interrupted", turnId: oldTurn });
  this.#emit({ type: "status", state: "idle", turnId: this.#turnId });
 }
 start() { this.interrupt(); this.#listening = true; this.#emit({ type: "status", state: "listening", turnId: this.#turnId }); }
 reset() { this.interrupt(); this.#history = []; }
 close() { this.#closed = true; this.interrupt(); }
 audio(bytes: Uint8Array) {
  if (!this.#listening) return;
  if (bytes.byteLength % 4 || bytes.byteLength > 64 * 1024) throw new Error("Invalid microphone chunk");
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (this.#sampleCount + samples.length > 16000 * 30) { this.interrupt(); throw new Error("Utterance exceeds 30 seconds"); }
  if (samples.some(value => !Number.isFinite(value) || Math.abs(value) > 1.01)) throw new Error("Invalid PCM samples");
  this.#chunks.push(samples); this.#sampleCount += samples.length;
 }
 async end() {
  if (!this.#listening) return;
  this.#listening = false;
  const turnId = this.#turnId, signal = this.#controller.signal;
  const pcm = new Float32Array(this.#sampleCount);
  let offset = 0; for (const chunk of this.#chunks) { pcm.set(chunk, offset); offset += chunk.length; }
  this.#chunks = []; this.#sampleCount = 0;
  const active = () => !signal.aborted && turnId === this.#turnId && !this.#closed;
  try {
   if (pcm.length < 1600) { this.#emit({ type: "status", state: "idle", turnId }); return; }
   this.#emit({ type: "status", state: "transcribing", turnId });
   const text = (await this.speech.transcribe(pcm, signal)).trim();
   if (!active()) return;
   if (!text) { this.#emit({ type: "status", state: "idle", turnId }); return; }
   this.#emit({ type: "transcript", text, turnId });
   this.#emit({ type: "status", state: "thinking", turnId });
   const pending: ChatMessage[] = [...this.#history, { role: "user", content: text }];
   const queue: string[] = [];
   let segment = "", finished = false, playbackError: Error | undefined;
   let wake = Promise.withResolvers<void>();
   const enqueue = (sentence: string) => {
    if (!sentence.trim()) return;
    if (queue.length >= 8) throw new Error("Speech playback queue is full");
    queue.push(sentence.trim()); wake.resolve();
   };
   const playback = (async () => {
    while (active() && (!finished || queue.length)) {
     if (!queue.length) { await wake.promise; wake = Promise.withResolvers<void>(); continue; }
     const sentence = queue.shift()!;
     this.#emit({ type: "status", state: "speaking", turnId });
     const audio = await this.speech.synthesize(sentence, signal);
     if (!active()) return;
     this.#emit({ type: "audio", ...audio, turnId });
    }
   })().catch(error => { playbackError = error instanceof Error ? error : new Error("Speech playback failed"); });
   const onText = (delta: string) => {
    if (!active()) return;
    if (playbackError) throw playbackError;
    this.#emit({ type: "assistant", text: delta, turnId });
    segment += delta;
    let sentence: RegExpMatchArray | null;
    while ((sentence = segment.match(/^([\s\S]*?[.!?])(?:\s+|$)/))) {
     enqueue(sentence[1]); segment = segment.slice(sentence[0].length);
    }
    if (segment.length > 400) { const split = segment.lastIndexOf(" ", 400); enqueue(segment.slice(0, split > 0 ? split : 400)); segment = segment.slice(split > 0 ? split : 400).trimStart(); }
   };
   let answer = "";
   try {
    for (let step = 0; step < 4; step++) {
     let streamed = false;
     const reply = await this.model.complete([{ role: "system", content: systemPrompt }, ...pending], signal, delta => { streamed = true; onText(delta); });
     if (!active()) return;
     if (!streamed && reply.content) onText(reply.content);
     if (!reply.tool_calls?.length) { answer = reply.content?.trim() ?? ""; break; }
     if (reply.tool_calls.length > 4) throw new Error("Too many tool calls");
     pending.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
     for (const call of reply.tool_calls) {
      this.#emit({ type: "tool", name: call.function.name, turnId });
      let content: string;
      if (call.function.name === "current_time") {
       const args: unknown = JSON.parse(call.function.arguments || "{}");
       if (!args || typeof args !== "object" || Object.keys(args).length) throw new Error("Invalid current_time arguments");
       content = JSON.stringify({ time: new Date().toISOString(), local: new Date().toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      } else content = JSON.stringify({ error: "Unknown tool" });
      pending.push({ role: "tool", content, tool_call_id: call.id });
     }
    }
    if (!answer) throw new Error("Model did not produce an answer within the tool limit");
    enqueue(segment);
    pending.push({ role: "assistant", content: answer });
    this.#history = pending;
    while (this.#history.length > 24 || JSON.stringify(this.#history).length > this.historyBudget) {
     this.#history.shift();
     while (this.#history.length && this.#history[0].role !== "user") this.#history.shift();
    }
   } finally { finished = true; wake.resolve(); await playback; }
   if (!active()) return;
   if (playbackError) throw playbackError;
   this.#emit({ type: "audio_end", turnId });
   this.#emit({ type: "status", state: "idle", turnId });
  } catch (error) {
   if (!active()) return;
   this.#emit({ type: "error", message: error instanceof Error ? error.message : "Voice processing failed", turnId });
   this.#emit({ type: "status", state: "idle", turnId });
  }
 }
}
