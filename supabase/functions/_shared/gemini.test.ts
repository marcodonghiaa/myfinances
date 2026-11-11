import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { classifyWithGemini } from "./gemini.ts";

const req = { prompt: "p", resultKey: "category", resultEnum: ["A", "B"], apiKey: "k", model: "m" };
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

Deno.test("returns the parsed JSON array from the first candidate", async () => {
  const text = JSON.stringify([{ entry_reference: "r1", category: "A" }]);
  const out = await classifyWithGemini(req, answer(200, { candidates: [{ content: { parts: [{ text }] } }] }));
  assertEquals(out, [{ entry_reference: "r1", category: "A" }]);
});

// protects=logs and errors never carry transaction text; fails_when=the API's body (which can
// echo the prompt) ends up in the thrown error
Deno.test("an API error carries only the status, never the body", async () => {
  const err = await assertRejects(() => classifyWithGemini(req, answer(503, { error: "echo of NETFLIX prompt" })));
  assertEquals([(err as Error).message, (err as { status: number }).status], ["Gemini API error 503", 503]);
});

Deno.test("an answer with no text is an error", async () => {
  const err = await assertRejects(() => classifyWithGemini(req, answer(200, { candidates: [] })));
  assertEquals((err as { code: string }).code, "GEMINI_EMPTY");
});
