import * as path from "node:path";
import { loadConfig } from "./config";
import { LlamaModel, startLlama } from "./llama";
import { SpeechProcess } from "./speech";
import { VoiceSession } from "./session";
export function isLocalOrigin(origin: string | null, host: string): boolean {
 if (!origin) return false;
 try { const url = new URL(origin); return url.protocol === "http:" && url.host === host && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); } catch { return false; }
}
export async function serve(root: string) {
 const config = await loadConfig(root);
 const llama = await startLlama(config.llama);
 const speech = new SpeechProcess(config.speech);
 const model = new LlamaModel(config.llama.port);
 const sessions = new Set<VoiceSession>();
 let server: Bun.Server<{ session?: VoiceSession }>;
 try { server = Bun.serve<{ session?: VoiceSession }>({
  hostname: "127.0.0.1", port: config.server.port, maxRequestBodySize: 64 * 1024,
  fetch(request, server) {
   const url = new URL(request.url);
   if (url.pathname === "/ws") {
    if (!isLocalOrigin(request.headers.get("origin"), url.host)) return new Response("Origin denied", { status: 403 });
    if (sessions.size >= 2) return new Response("Voice session limit reached", { status: 503 });
    if (server.upgrade(request, { data: {} })) return;
    return new Response("Websocket upgrade required", { status: 400 });
   }
   if (url.pathname === "/health") return Response.json({ status: "ok", local: true, sampleRate: 16000, outputSampleRate: 24000 });
   const files: Record<string, string> = { "/": "web/index.html", "/app.js": ".build/app.js", "/styles.css": "web/styles.css", "/style.css": "web/style.css", "/mic-worklet.js": "web/capture-worklet.js", "/capture-worklet.js": "web/capture-worklet.js" };
   const file = files[url.pathname];
   if (!file) return new Response("Not found", { status: 404 });
   return new Response(Bun.file(path.join(root, file)));
  },
  websocket: {
   maxPayloadLength: 64 * 1024, backpressureLimit: 8 * 1024 * 1024, closeOnBackpressureLimit: true,
   open(ws) {
    const session = new VoiceSession(model, speech, event => {
     if (ws.send(JSON.stringify(event)) === 0) { session.close(); ws.close(1013, "Playback queue exceeded"); }
    }, Math.max(1000, (config.llama.contextSize - 1000) * 3));
    ws.data.session = session; sessions.add(session);
    ws.send(JSON.stringify({ type: "ready" }));
   },
   message(ws, message) {
    const session = ws.data.session; if (!session) return;
    try {
     if (typeof message !== "string") { session.audio(message); return; }
     if (message.length > 1024) throw new Error("Control message exceeds limit");
     const control = JSON.parse(message) as { type?: string };
     switch (control.type) {
      case "start": session.start(); break;
      case "end": void session.end(); break;
      case "interrupt": session.interrupt(); break;
      case "reset": session.reset(); break;
      default: throw new Error("Unknown voice command");
     }
    } catch (error) { ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Invalid voice message" })); }
   },
   close(ws) { if (ws.data.session) { ws.data.session.close(); sessions.delete(ws.data.session); } },
  },
 }); } catch (error) { speech.close(); llama.kill(); throw error; }
 const shutdown = () => { for (const session of sessions) session.close(); server.stop(true); speech.close(); llama.kill(); };
 process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
 console.log(`Local voice agent: http://127.0.0.1:${server.port}`);
 return { server, shutdown };
}
if (import.meta.main) {
 try { await serve(path.resolve(import.meta.dir, "..")); }
 catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
