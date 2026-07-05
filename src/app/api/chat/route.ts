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
import { prisma } from "@/lib/db";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, personaId }: { messages: UIMessage[]; personaId?: string } =
    await req.json();

  // The requester identity comes from the (demo) session, never from the model.
  const persona = await prisma.user.findFirst({
    where: { id: personaId ?? "", isAdmin: false },
  });
  if (!persona) {
    return Response.json({ error: "Unknown persona" }, { status: 400 });
  }

  const result = streamText({
    model: anthropic("claude-opus-4-8"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: buildTools(persona.id),
    stopWhen: isStepCount(8),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
