import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SpeechProcess } from "../server/speech";

test("speech subprocess exit rejects pending inference and a later request restarts the worker", async () => {
 const temp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-worker-contract-"));
 const workerPath = path.join(temp, "worker.cjs");
 // This fixture behaves like a crashed worker, without touching process globals.
 await Bun.write(workerPath, "process.stdin.once('data', () => process.exit(7));");
 const speech = new SpeechProcess({ workerPath, whisperPath: temp, kokoroPath: temp, voice: "af_heart" });
 try {
  await expect(speech.transcribe(new Float32Array(1600), new AbortController().signal)).rejects.toThrow("Speech worker exited (7)");
  await expect(speech.transcribe(new Float32Array(1600), new AbortController().signal)).rejects.toThrow("Speech worker exited (7)");
 } finally { speech.close(); await fs.rm(temp, { recursive: true, force: true }); }
});
