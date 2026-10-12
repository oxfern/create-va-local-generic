import * as path from "node:path";
import { installModelFile, loadModelLock, verifyModels } from "./model-store";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  const missing = await verifyModels(root);
  if (missing.length) throw new Error(`Missing or corrupt models (${missing.length} files). Run setup.\n${missing.join("\n")}`);
  console.log("All model files match their pinned checksums.");
} else {
  const lock = await loadModelLock(root);
  const only = [...args].find(arg => arg.startsWith("--only="))?.slice(7);
  if (only && !lock.models.some(model => model.id === only)) throw new Error(`Unknown model '${only}'. Choose ${lock.models.map(model => model.id).join(", ")}.`);
  for (const model of lock.models.filter(model => !only || model.id === only)) {
    console.log(`${model.id}: ${model.repo}@${model.revision}`);
    for (const asset of model.files) {
      const target = path.join(root, ".cache/models", model.id, asset.path);
      console.log(`  ${asset.path} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`);
      const result = await installModelFile(target, asset);
      console.log(`  ${result}`);
    }
  }
  console.log("Models ready. Start the agent with bun run dev.");
}
