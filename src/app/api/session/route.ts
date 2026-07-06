import { NextResponse } from "next/server";
import {
  resolvePersonaId,
  signSession,
  PERSONA_COOKIE,
  SESSION_COOKIE_OPTS,
} from "@/lib/session";

// Establish the employee session (the demo persona-picker). Validates the persona is
// a real non-admin user, then stores a SIGNED httpOnly cookie. The chat route reads
// identity from this cookie only — never from its request body.
export async function POST(req: Request) {
  let personaId: unknown;
  try {
    ({ personaId } = (await req.json()) as { personaId?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof personaId !== "string") {
    return NextResponse.json({ error: "personaId is required" }, { status: 400 });
  }

  const resolved = await resolvePersonaId(personaId);
  if (!resolved) {
    return NextResponse.json({ error: "Unknown persona" }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, personaId: resolved });
  res.cookies.set(PERSONA_COOKIE, signSession(resolved), SESSION_COOKIE_OPTS);
  return res;
}
