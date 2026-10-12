import { expect, test } from "bun:test";
import { LlamaModel } from "../server/llama";

test("SSE fragments assemble spoken text and tool arguments while keeping reasoning out of speech", async () => {
 let payload: { stream?: boolean; chat_template_kwargs?: { enable_thinking?: boolean } } = {};
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  payload = await request.json();
  const data = [
   { choices: [{ delta: { reasoning_content: "Do not speak this", content: "Hello " } }] },
   { choices: [{ delta: { content: "world.", tool_calls: [{ index: 0, id: "call_1", function: { name: "current_time", arguments: "{" } }] } }] },
   { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
  ].map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
   for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
   controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
 } });
 try {
  const spoken: string[] = [];
  const result = await new LlamaModel(server.port!).complete([{ role: "user", content: "Time?" }], new AbortController().signal, delta => spoken.push(delta));
  expect(spoken.join("")).toBe("Hello world.");
  expect(result.tool_calls?.[0].function.arguments).toBe("{}");
  expect(result.tool_calls?.[0].id).toBe("call_1");
  expect(payload.stream).toBe(true);
  expect(payload.chat_template_kwargs?.enable_thinking).toBe(false);
 } finally { server.stop(true); }
});
