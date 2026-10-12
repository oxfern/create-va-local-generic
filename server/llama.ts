import type { Config } from "./config";
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface Completion { content: string | null; tool_calls?: ToolCall[] }
export interface LanguageModel { complete(messages: ChatMessage[], signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> }
export const timeTool = { type: "function", function: { name: "current_time", description: "Get the current local date, time and timezone.", parameters: { type: "object", properties: {}, additionalProperties: false } } };
export class LlamaModel implements LanguageModel {
 constructor(readonly port: number) {}
 async complete(messages: ChatMessage[], signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> {
  const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, tools: [timeTool], tool_choice: "auto", temperature: 0.6, max_tokens: 384, stream: true, chat_template_kwargs: { enable_thinking: false } }) });
  if (!response.ok) throw new Error(`Local model request failed (${response.status})`);
  if (!response.body) throw new Error("Local model returned no stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", finished = false;
  const tools = new Map<number, ToolCall>();
  interface Chunk { choices?: { finish_reason?: string | null; delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; error?: { message?: string } }
  const line = (text: string) => {
   if (!text.startsWith("data:")) return;
   const data = text.slice(5).trim(); if (!data) return; if (data === "[DONE]") { finished = true; return; }
   const chunk = JSON.parse(data) as Chunk;
   if (chunk.error) throw new Error(chunk.error.message ?? "Local model stream failed");
   if (chunk.choices?.[0]?.finish_reason) finished = true;
   const delta = chunk.choices?.[0]?.delta;
   if (delta?.content) { content += delta.content; onText?.(delta.content); }
   for (const partial of delta?.tool_calls ?? []) {
    if (!Number.isInteger(partial.index) || partial.index < 0 || partial.index > 3) throw new Error("Invalid streamed tool call");
    const call = tools.get(partial.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
    if (partial.id) call.id += partial.id;
    if (partial.function?.name) call.function.name += partial.function.name;
    if (partial.function?.arguments) call.function.arguments += partial.function.arguments;
    if (call.function.arguments.length > 8192) throw new Error("Tool arguments exceed limit");
    tools.set(partial.index, call);
   }
  };
  try {
   while (true) {
    signal.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) { buffer += decoder.decode(); if (buffer.trim()) line(buffer.replace(/\r$/, "")); break; }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 64 * 1024) throw new Error("Model stream line exceeds limit");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, newline).replace(/\r$/, "")); buffer = buffer.slice(newline + 1); }
    if (content.length > 16_384) throw new Error("Model response exceeds limit");
   }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!finished) throw new Error("Local model stream ended before completion");
  const tool_calls = [...tools.values()];
  if (tool_calls.some(call => !call.id || !call.function.name)) throw new Error("Incomplete streamed tool call");
  if (!content && !tool_calls.length) throw new Error("Local model returned an empty response");
  return { content: content || null, ...(tool_calls.length ? { tool_calls } : {}) };
 }
}
export async function startLlama(config: Config["llama"]): Promise<Bun.Subprocess> {
 if (!(await Bun.file(config.binaryPath).exists())) throw new Error(`llama-server missing: ${config.binaryPath}`);
 if (!(await Bun.file(config.modelPath).exists())) throw new Error(`GGUF model missing: ${config.modelPath}. Run setup first.`);
 // Inherit diagnostic stderr; llama-server never listens on a public interface.
 const child = Bun.spawn([config.binaryPath, "--model", config.modelPath, "--host", "127.0.0.1", "--port", String(config.port), "--ctx-size", String(config.contextSize), "--threads", String(config.threads), "--n-gpu-layers", String(config.gpuLayers), "--jinja"], { stdout: "ignore", stderr: "inherit" });
 const deadline = Date.now() + 180_000;
 while (Date.now() < deadline) {
  if (child.exitCode !== null) throw new Error(`llama-server exited (${child.exitCode})`);
  try { if ((await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) })).ok) return child; } catch {}
  await Bun.sleep(250);
 }
 child.kill();
 throw new Error("llama-server startup timed out");
}
