import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ModelFile {
  path: string;
  url: string;
  sha256: string;
  size: number;
}
export interface LockedModel {
  id: string;
  repo: string;
  revision: string;
  license: string;
  files: ModelFile[];
}
export interface ModelLock { version: 1; models: LockedModel[] }

export async function loadModelLock(root: string): Promise<ModelLock> {
  const lock: ModelLock = await Bun.file(path.join(root, "models.lock.json")).json();
  if (lock.version !== 1 || !Array.isArray(lock.models)) throw new Error("Unsupported models.lock.json. Restore the template lock or use version 1.");
  for (const model of lock.models) {
    if (!/^[a-z0-9-]+$/.test(model.id) || !/^[a-f0-9]{40}$/.test(model.revision)) throw new Error("Invalid model id or immutable revision in models.lock.json.");
    for (const file of model.files) {
      if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..") || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error(`Invalid model asset: ${model.id}/${file.path}`);
      const url = new URL(file.url);
      if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || !url.pathname.startsWith(`/${model.repo}/resolve/${model.revision}/`)) throw new Error(`Model asset must use its pinned Hugging Face revision: ${file.path}`);
    }
  }
  return lock;
}

export async function sha256File(filename: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filename).stream()) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyModelFile(filename: string, asset: ModelFile): Promise<boolean> {
  try {
    const file = Bun.file(filename);
    if (file.size !== asset.size) return false;
    return await sha256File(filename) === asset.sha256;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function installModelFile(filename: string, asset: ModelFile, fetcher: typeof fetch = fetch): Promise<"cached" | "downloaded"> {
  if (await verifyModelFile(filename, asset)) return "cached";
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part`;
  try {
    const response = await fetcher(asset.url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok) throw new Error(`Download returned HTTP ${response.status}: ${asset.url}`);
    if (!response.body) throw new Error(`Download returned no data: ${asset.path}`);
    await Bun.write(temporary, "");
    const writer = Bun.file(temporary).writer();
    try {
      for await (const chunk of response.body) writer.write(chunk);
    } finally { await writer.end(); }
    if (!await verifyModelFile(temporary, asset)) throw new Error(`Checksum mismatch for ${asset.path}. Run setup again to retry the download.`);
    await fs.rename(temporary, filename);
    return "downloaded";
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function verifyModels(root: string): Promise<string[]> {
  const lock = await loadModelLock(root);
  const missing: string[] = [];
  for (const model of lock.models) for (const asset of model.files) {
    if (!await verifyModelFile(path.join(root, ".cache/models", model.id, asset.path), asset)) missing.push(`${model.id}/${asset.path}`);
  }
  return missing;
}
