import * as path from "node:path";
export interface Config {
 server: { port: number };
 llama: { binaryPath: string; modelPath: string; port: number; contextSize: number; threads: number; gpuLayers: number };
 speech: { whisperPath: string; kokoroPath: string; nodeBinary: string; workerPath: string; voice: string };
}
export async function loadConfig(root: string): Promise<Config> {
 const config: Config = await Bun.file(path.join(root, "config.json")).json();
 for (const key of ["port", "contextSize", "threads", "gpuLayers"] as const) {
  if (!Number.isInteger(config.llama[key])) throw new Error(`Invalid llama.${key}`);
 }
 if (config.llama.port < 1024 || config.llama.port > 65535 || config.server.port < 1024 || config.server.port > 65535 || config.llama.contextSize < 512 || config.llama.threads < 1) throw new Error("Invalid runtime configuration");
 for (const key of ["binaryPath", "modelPath"] as const) config.llama[key] = path.resolve(root, config.llama[key]);
 for (const key of ["whisperPath", "kokoroPath", "workerPath", "nodeBinary"] as const) config.speech[key] = path.resolve(root, config.speech[key]);
 return config;
}
