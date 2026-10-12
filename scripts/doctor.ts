import { $ } from "bun";
import { access, constants } from "node:fs/promises";
import { loadConfig } from "../server/config";
import { verifyModels } from "./model-store";

const root = process.cwd();
const config = await loadConfig(root);
let failed = false;
for (const [label, binary, argument] of [
  ["Bun application runtime", "./.tools/bin/bun", "--version"],
] as const) {
  try {
    const result = await $`${binary} ${argument}`.quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
    console.log(`${label}: ${result.text().trim() || result.stderr.toString().trim()}`);
  } catch {
    failed = true;
    console.error(`${label}: unavailable. Run ./scripts/install-tools.sh to restore pinned tools.`);
  }
}
try {
  await access(config.llama.binaryPath, constants.X_OK);
  console.log(`Local LLM runtime: ${config.llama.binaryPath}`);
} catch {
  failed = true;
  console.error("Local LLM runtime: unavailable. Run ./scripts/install-tools.sh.");
}
const missing = await verifyModels(root);
if (missing.length) {
  failed = true;
    console.error(`Models: ${missing.length} missing or corrupt files. Run bun run setup.`);
} else console.log("Models: checksums verified; speech and conversation can run offline.");
if (!await Bun.file(config.speech.workerPath).exists()) {
  failed = true;
  console.error("Speech worker: missing. Restore server/speech-worker.ts from the repository.");
}
console.log(`Browser: http://127.0.0.1:${config.server.port}; microphone permission is requested when you connect.`);
console.log("Speech engines: CPU. LLM: configured GPU layers " + config.llama.gpuLayers + ".");
process.exitCode = failed ? 1 : 0;
