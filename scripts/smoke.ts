import { loadConfig } from "../server/config";
import { SpeechProcess } from "../server/speech";
import { serve } from "../server/server";
import { decodePcm, encodePcm, MonoResampler } from "../web/audio";
import { verifyModels } from "./model-store";

interface LocalWebSocketConstructor {
  new(url: string, options: Bun.WebSocketOptions): WebSocket;
}
// Bun accepts request headers; the browser DOM constructor type omits them.
const LocalWebSocket = WebSocket as unknown as LocalWebSocketConstructor;

const root = process.cwd();
const missing = await verifyModels(root);
if (missing.length) throw new Error("Smoke needs local models. Run the setup task first.");
const config = await loadConfig(root);
const speech = new SpeechProcess(config.speech);
const started = performance.now();
let utterance: Float32Array;
try {
  const audio = await speech.synthesize("Please say hello in one sentence.", AbortSignal.timeout(180_000));
  const samples = decodePcm(audio.samples);
  if (samples.length < 2400 || !samples.some(sample => Math.abs(sample) > 0.01)) throw new Error("Kokoro did not generate audible PCM.");
  utterance = new MonoResampler(audio.sampleRate).process(samples);
  const transcript = await speech.transcribe(utterance, AbortSignal.timeout(180_000));
  if (!/hello/i.test(transcript)) throw new Error(`Speech round trip failed: ${transcript}`);
  console.log(`Local Kokoro → Whisper passed (${Math.round(performance.now() - started)} ms): ${transcript.trim()}`);
} finally { speech.close(); }

const running = await serve(root);
const origin = `http://127.0.0.1:${running.server.port}`;
let socket: WebSocket | undefined;
try {
  const response = await fetch(`${origin}/health`);
  if (!response.ok) throw new Error("Local HTTP health check failed.");
  const denied = await fetch(`${origin}/ws`, { headers: { Origin: "https://example.com" } });
  if (denied.status !== 403) throw new Error("Cross-origin voice connections were accepted.");
  const finished = Promise.withResolvers<void>();
  const timer = setTimeout(() => finished.reject(new Error("Voice conversation timed out.")), 180_000);
  let transcript = "", answer = "", audioSamples = 0, firstAudioMs: number | undefined;
  const turnStarted = performance.now();
  socket = new LocalWebSocket(origin.replace("http:", "ws:") + "/ws", { headers: { Origin: origin } });
  socket.onerror = () => finished.reject(new Error("Local voice WebSocket failed."));
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { type: string; text?: string; samples?: string; message?: string };
      if (message.type === "ready") {
        socket!.send(JSON.stringify({ type: "start" }));
        for (let offset = 0; offset < utterance.length; offset += 4096) socket!.send(encodePcm(utterance.slice(offset, offset + 4096)));
        socket!.send(JSON.stringify({ type: "end" }));
      } else if (message.type === "transcript") transcript = message.text ?? "";
      else if (message.type === "assistant") answer += message.text ?? "";
      else if (message.type === "audio") {
        const samples = decodePcm(message.samples ?? "");
        audioSamples += samples.length;
        firstAudioMs ??= Math.round(performance.now() - turnStarted);
      } else if (message.type === "error") finished.reject(new Error(message.message ?? "Voice turn failed."));
      else if (message.type === "audio_end") finished.resolve();
    } catch (error) { finished.reject(error); }
  };
  try { await finished.promise; } finally { clearTimeout(timer); }
  if (!/hello/i.test(transcript) || !/hello|hi\b|greet/i.test(answer) || audioSamples < 2400) throw new Error(`Incomplete voice conversation: ${JSON.stringify({ transcript, answer, audioSamples })}`);
  console.log(JSON.stringify({ transcript: transcript.trim(), answer, audioSamples, firstAudioMs, totalMs: Math.round(performance.now() - turnStarted) }, null, 2));
  console.log("Full local voice conversation passed without using a microphone or speaker device.");
} finally { socket?.close(); running.shutdown(); }
