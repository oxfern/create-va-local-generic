import { expect, test } from "bun:test";
import type { ChatMessage, Completion, LanguageModel } from "../server/llama";
import { VoiceSession, type Event, type Speech } from "../server/session";
import { isLocalOrigin } from "../server/server";
const pcm = new Uint8Array(new Float32Array(1600).buffer);
const speech: Speech = { async transcribe() { return "What time is it?"; }, async synthesize() { return { samples: "AAAAAA==", sampleRate: 24000 }; } };
test("a time request executes a local tool and retains the exchange for the next utterance", async () => {
 const calls: ChatMessage[][] = [];
 const model: LanguageModel = { async complete(messages) {
  calls.push(messages);
  if (calls.length === 1) return { content: null, tool_calls: [{ id: "time-1", type: "function", function: { name: "current_time", arguments: "{}" } }] };
  return { content: "The current time is available." };
 } };
 const events: Event[] = [];
 const session = new VoiceSession(model, speech, event => events.push(event));
 session.start(); session.audio(pcm); await session.end();
 const tool = calls[1].find(message => message.role === "tool");
 expect(JSON.parse(tool!.content!).time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 expect(tool?.tool_call_id).toBe("time-1");
 expect(events.filter(event => event.type === "audio_end")).toHaveLength(1);
 session.start(); session.audio(pcm); await session.end();
 expect(calls[2].filter(message => message.role === "user")).toHaveLength(2);
 session.reset(); session.start(); session.audio(pcm); await session.end();
 expect(calls[3].filter(message => message.role === "user")).toHaveLength(1);
});
test("interrupt aborts LLM and suppresses a completion returned after a newer turn", async () => {
 const deferred = Promise.withResolvers<Completion>();
 let llmSignal: AbortSignal | undefined;
 const model: LanguageModel = { complete(_messages, signal) { llmSignal = signal; return deferred.promise; } };
 const events: Event[] = [];
 const session = new VoiceSession(model, speech, event => events.push(event));
 session.start(); session.audio(pcm); const end = session.end();
 await Bun.sleep(0);
 session.interrupt(); deferred.resolve({ content: "Stale reply" }); await end;
 expect(llmSignal?.aborted).toBe(true);
 expect(events.some(event => event.type === "assistant" || event.type === "audio")).toBe(false);
 expect(events.findLast(event => event.type === "interrupted")?.turnId).toBe(1);
});
test("interrupt suppresses in-flight synthesized audio", async () => {
 const deferred = Promise.withResolvers<{ samples: string; sampleRate: number }>();
 const events: Event[] = [];
 const session = new VoiceSession({ async complete() { return { content: "Hello." }; } }, { ...speech, synthesize() { return deferred.promise; } }, event => events.push(event));
 session.start(); session.audio(pcm); const end = session.end(); await Bun.sleep(0);
 session.start(); deferred.resolve({ samples: "AAAAAA==", sampleRate: 24000 }); await end;
 expect(events.some(event => event.type === "audio" || event.type === "audio_end")).toBe(false);
 expect(events.findLast(event => event.type === "status")?.state).toBe("listening");
});
test("invalid PCM and cross-origin browser connections are rejected", () => {
 const session = new VoiceSession({ async complete() { return { content: "unused" }; } }, speech, () => {});
 session.start();
 expect(() => session.audio(new Uint8Array(3))).toThrow("Invalid microphone chunk");
 expect(() => session.audio(new Uint8Array(new Float32Array([NaN]).buffer))).toThrow("Invalid PCM");
 expect(isLocalOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
 expect(isLocalOrigin("http://evil.example:3000", "127.0.0.1:3000")).toBe(false);
 expect(isLocalOrigin("http://127.0.0.1:4000", "127.0.0.1:3000")).toBe(false);
 expect(isLocalOrigin(null, "127.0.0.1:3000")).toBe(false);
});
test("a completed sentence reaches speech before language generation finishes", async () => {
 const finished = Promise.withResolvers<Completion>();
 const synthesis = Promise.withResolvers<void>();
 const events: Event[] = [];
 const session = new VoiceSession({ complete(_messages, _signal, onText) { onText?.("Hello there. "); return finished.promise; } }, {
  ...speech, async synthesize() { synthesis.resolve(); return { samples: "AAAAAA==", sampleRate: 24000 }; },
 }, event => events.push(event));
 session.start(); session.audio(pcm); const turn = session.end();
 await synthesis.promise;
 await Bun.sleep(0);
 expect(events.some(event => event.type === "audio")).toBe(true);
 expect(events.some(event => event.type === "audio_end")).toBe(false);
 finished.resolve({ content: "Hello there." }); await turn;
 expect(events.filter(event => event.type === "assistant").map(event => event.text)).toEqual(["Hello there. "]);
});
