import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installModelFile, loadModelLock, type ModelFile, verifyModelFile } from "../scripts/model-store";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function temp(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-"));
  directories.push(directory);
  return directory;
}
const content = "verified model bytes";
const asset: ModelFile = { path: "weights.bin", url: "https://huggingface.co/example/model/resolve/" + "a".repeat(40) + "/weights.bin", size: content.length, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") };

test("a corrupt download never replaces an existing model and is removed", async () => {
  const target = path.join(await temp(), "weights.bin");
  await Bun.write(target, "prior bytes");
  const fetcher: typeof fetch = Object.assign(async () => new Response("wrong bytes"), { preconnect: fetch.preconnect });
  await expect(installModelFile(target, asset, fetcher)).rejects.toThrow("Checksum mismatch");
  expect(await Bun.file(target).text()).toBe("prior bytes");
  expect(await Bun.file(`${target}.part`).exists()).toBe(false);
});

test("a verified download becomes usable and cached setup never fetches again", async () => {
  const target = path.join(await temp(), "nested/weights.bin");
  let calls = 0;
  const fetcher: typeof fetch = Object.assign(async () => { calls++; return new Response(content); }, { preconnect: fetch.preconnect });
  expect(await installModelFile(target, asset, fetcher)).toBe("downloaded");
  expect(await verifyModelFile(target, asset)).toBe(true);
  expect(await installModelFile(target, asset, fetcher)).toBe("cached");
  expect(calls).toBe(1);
});

test("model lock rejects assets escaping the model cache", async () => {
  const root = await temp();
  await Bun.write(path.join(root, "models.lock.json"), JSON.stringify({ version: 1, models: [{ id: "test", repo: "example/model", revision: "a".repeat(40), files: [{ ...asset, path: "../escape.bin" }] }] }));
  await expect(loadModelLock(root)).rejects.toThrow("Invalid model asset");
});
