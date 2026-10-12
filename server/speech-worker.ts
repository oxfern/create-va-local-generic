import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { env, pipeline, RawAudio, Tensor, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
// This module is compiled to CJS and run only in Node, never inside Bun.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
globalThis.fetch = Object.assign(async () => { throw new Error("Network access is disabled in the local speech worker"); }, { preconnect: globalThis.fetch.preconnect });
const [whisperPath, kokoroPath, voice = "af_heart"] = process.argv.slice(2);
if (!whisperPath || !kokoroPath) throw new Error("Local speech model paths are required");
class LocalKokoro extends KokoroTTS {
 #voiceData = new Map<string, Float32Array>();
 override async generate_from_ids(input_ids: Tensor, options: { voice?: keyof KokoroTTS["voices"]; speed?: number } = {}): Promise<RawAudio> {
  const selected = options.voice ?? "af_heart";
  this._validate_voice(selected);
  let data = this.#voiceData.get(selected);
  if (!data) {
   const bytes = await fs.readFile(path.join(kokoroPath, "voices", `${selected}.bin`));
   data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
   this.#voiceData.set(selected, data);
  }
  const offset = 256 * Math.min(Math.max(input_ids.dims[input_ids.dims.length - 1] - 2, 0), 509);
  const style = data.slice(offset, offset + 256);
  if (style.length !== 256) throw new Error("Local Kokoro voice file is incomplete");
  const output = await this.model({ input_ids, style: new Tensor("float32", style, [1, 256]), speed: new Tensor("float32", [options.speed ?? 1], [1]) });
  return new RawAudio(output.waveform.data as Float32Array, 24000);
 }
}
interface Request { id: number; type: "transcribe" | "synthesize" | "cancel"; samples?: string; text?: string }
const queue: Request[] = [];
const cancelled = new Set<number>();
let running = false;
const reply = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Lazy initialization keeps the request protocol responsive while models load.
const models = async () => {
 const [stt, base] = await Promise.all([
  // ORT 1.26 extended QDQ weight rewrites fail on Whisper decoder embedding scales.
  // Basic optimization retains native CPU execution without that faulty rewrite.
  pipeline("automatic-speech-recognition", whisperPath, { dtype: "q8", device: "cpu", local_files_only: true, session_options: { graphOptimizationLevel: "basic" } }),
  KokoroTTS.from_pretrained(kokoroPath, { dtype: "q8", device: "cpu" }),
 ]);
 return { stt, tts: new LocalKokoro(base.model, base.tokenizer) };
};
let loaded: Promise<{ stt: AutomaticSpeechRecognitionPipeline; tts: LocalKokoro }> | undefined;
async function pump() {
 if (running) return;
 running = true;
 try {
  while (queue.length) {
   const request = queue.shift()!;
   if (cancelled.delete(request.id)) continue;
   try {
    loaded ??= models().catch(error => { loaded = undefined; throw error; });
    const { stt, tts } = await loaded;
    if (cancelled.delete(request.id)) continue;
    if (request.type === "transcribe") {
     const bytes = Buffer.from(request.samples ?? "", "base64");
     if (bytes.byteLength % 4 || bytes.byteLength > 16000 * 30 * 4) throw new Error("Invalid microphone payload");
     const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
     const result = await stt(samples, { language: "english", task: "transcribe" });
     if (!cancelled.delete(request.id)) reply({ id: request.id, text: Array.isArray(result) ? result[0].text : result.text });
    } else {
     if (!request.text || request.text.length > 4096) throw new Error("Invalid speech text");
     if (!(voice in tts.voices)) throw new Error("Unknown configured voice");
     const audio = await tts.generate(request.text, { voice: voice as keyof KokoroTTS["voices"] });
     if (audio.audio.length > 24000 * 60) throw new Error("Generated audio exceeds limit");
     if (!cancelled.delete(request.id)) reply({ id: request.id, samples: Buffer.from(audio.audio.buffer, audio.audio.byteOffset, audio.audio.byteLength).toString("base64"), sampleRate: audio.sampling_rate });
    }
   } catch (error) {
    if (!cancelled.delete(request.id)) reply({ id: request.id, error: error instanceof Error ? error.message : "Speech inference failed" });
   }
  }
 } finally { running = false; }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
 try {
  if (line.length > 3 * 1024 * 1024) throw new Error("Worker request exceeds limit");
  const request = JSON.parse(line) as Request;
  if (!Number.isInteger(request.id) || !["cancel", "transcribe", "synthesize"].includes(request.type)) throw new Error("Invalid worker request");
  if (request.type === "cancel") {
   const index = queue.findIndex(item => item.id === request.id);
   if (index >= 0) queue.splice(index, 1);
   else { cancelled.add(request.id); if (cancelled.size > 16) cancelled.delete(cancelled.values().next().value!); }
   return;
  }
  if (queue.length >= 4) { reply({ id: request.id, error: "Speech queue is full" }); return; }
  queue.push(request); void pump();
 } catch (error) { process.stderr.write(`Speech protocol error: ${error instanceof Error ? error.message : "invalid request"}\n`); }
});
