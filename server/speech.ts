import type { Config } from "./config";
import type { Speech } from "./session";
interface Reply { id: number; text?: string; samples?: string; sampleRate?: number; error?: string }
interface Pending { resolve: (reply: Reply) => void; reject: (error: Error) => void; cleanup: () => void }
export class SpeechProcess implements Speech {
 #child: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
 #pending = new Map<number, Pending>();
 #id = 0;
 #stopped = false;
 constructor(readonly config: Config["speech"]) {}
 #fail(child: Bun.Subprocess, error: Error) {
  if (this.#child !== child) return;
  this.#child = null;
  for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
  this.#pending.clear(); child.kill();
 }
 #start() {
  if (this.#stopped) throw new Error("Speech runtime closed");
  if (this.#child) return this.#child;
  const child = Bun.spawn([this.config.nodeBinary, this.config.workerPath, this.config.whisperPath, this.config.kokoroPath, this.config.voice || "af_heart"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  this.#child = child;
  void this.#read(child);
  void child.exited.then(code => this.#fail(child, new Error(`Speech worker exited (${code}); retry to restart`)));
  return child;
 }
 async #read(child: Bun.Subprocess<"pipe", "pipe", "inherit">) {
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
   while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 16 * 1024 * 1024) throw new Error("Speech worker output exceeds limit");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
     const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
     if (!line) continue;
     const reply = JSON.parse(line) as Reply;
     const pending = this.#pending.get(reply.id); if (!pending) continue;
     this.#pending.delete(reply.id); pending.cleanup();
     if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply);
    }
   }
  } catch (error) { this.#fail(child, error instanceof Error ? error : new Error("Speech worker protocol failed")); }
  finally { reader.releaseLock(); }
 }
 async #request(payload: object, signal: AbortSignal): Promise<Reply> {
  signal.throwIfAborted();
  if (this.#pending.size >= 4) throw new Error("Speech queue is full; retry shortly");
  const child = this.#start(), id = ++this.#id;
  const deferred = Promise.withResolvers<Reply>();
  const abort = () => {
   const pending = this.#pending.get(id); if (!pending) return;
   this.#pending.delete(id); pending.cleanup(); deferred.reject(new Error("Turn cancelled"));
   try { child.stdin.write(`${JSON.stringify({ type: "cancel", id })}\n`); } catch {}
  };
  const timer = setTimeout(() => this.#fail(child, new Error("Speech worker timed out; retry to restart")), 180_000);
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
  this.#pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, cleanup });
  signal.addEventListener("abort", abort, { once: true });
  try { child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`); await child.stdin.flush(); }
  catch { this.#fail(child, new Error("Speech worker input failed; retry to restart")); }
  return deferred.promise;
 }
 async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
  const result = await this.#request({ type: "transcribe", samples: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64") }, signal);
  if (typeof result.text !== "string") throw new Error("Speech worker returned invalid transcript");
  return result.text;
 }
 async synthesize(text: string, signal: AbortSignal): Promise<{ samples: string; sampleRate: number }> {
  const result = await this.#request({ type: "synthesize", text }, signal);
  if (typeof result.samples !== "string" || result.sampleRate !== 24000) throw new Error("Speech worker returned invalid audio");
  return { samples: result.samples, sampleRate: result.sampleRate };
 }
 close() { this.#stopped = true; if (this.#child) this.#fail(this.#child, new Error("Speech runtime closed")); }
}
