import {
  streamText,
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
  isStepCount,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { buildTools } from "@/lib/agent/tools";
import { getRequesterId } from "@/lib/session";

export const maxDuration = 60;

export async function POST(req: Request) {
  // Identity comes from the signed session cookie, never from the request body — the
  // model cannot choose whose behalf it acts on.
  const requesterId = await getRequesterId();
  if (!requesterId) {
    return Response.json(
      { error: "No active session — pick a persona first." },
      { status: 401 },
    );
  }

  let messages: UIMessage[];
  try {
    ({ messages } = (await req.json()) as { messages: UIMessage[] });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(messages)) {
    return Response.json({ error: "messages must be an array" }, { status: 400 });
  }

  const result = streamText({
    model: anthropic("claude-opus-4-8"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: buildTools(requesterId),
    stopWhen: isStepCount(8),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      // Default masks all errors to "An error occurred." Surface an actionable message
      // to the client without leaking internals, and log the real error server-side.
      onError: (error) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (/api[_ -]?key|x-api-key|401|unauthorized/i.test(msg)) {
          return "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY and restart.";
        }
        console.error("[greenlight] chat stream error:", error);
        return "Greenlight hit an error handling that request. Any ticket it created is preserved — check the IT console.";
      },
    }),
  });
}
