import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

// Session identity for Greenlight.
//
// The point of this file: identity is derived server-side from a SIGNED, httpOnly
// cookie — never from a request body. Before, the chat route trusted `personaId`
// sent inline with the model's message payload, so any client (or the model's own
// output shape) could choose whose identity the agent acted under. Now the cookie
// is HMAC-signed with SESSION_SECRET, so a client can't forge a different persona
// or forge an admin session, and getAdminId() is the single authorization chokepoint
// every privileged mutation passes through.
//
// This is a demo (no login): the persona-picker sets the employee cookie and the IT
// console mints the admin cookie. Those two mint points are the seam where real
// IdP/SSO login drops in — getRequesterId()/getAdminId() and every route guard stay
// exactly as they are.

const SECRET = process.env.SESSION_SECRET ?? "greenlight-dev-secret-change-me";

export const PERSONA_COOKIE = "gl_persona";
export const ADMIN_COOKIE = "gl_admin";
export const SESSION_COOKIE_OPTS = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  path: "/",
};

export function signSession(value: string): string {
  const mac = createHmac("sha256", SECRET).update(value).digest("hex");
  return `${value}.${mac}`;
}

function verifySession(signed: string | undefined): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const mac = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", SECRET).update(value).digest("hex"));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return value;
}

/** Authenticated employee id from the signed cookie, or null. Never reads the body. */
export async function getRequesterId(): Promise<string | null> {
  const id = verifySession((await cookies()).get(PERSONA_COOKIE)?.value);
  if (!id) return null;
  const user = await prisma.user.findFirst({ where: { id, isAdmin: false } });
  return user?.id ?? null;
}

/** Authenticated admin id from the signed admin cookie, or null. */
export async function getAdminId(): Promise<string | null> {
  const id = verifySession((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!id) return null;
  const admin = await prisma.user.findFirst({ where: { id, isAdmin: true } });
  return admin?.id ?? null;
}

/** Validate a persona-picker selection is a real non-admin user before we sign it. */
export async function resolvePersonaId(personaId: string): Promise<string | null> {
  const user = await prisma.user.findFirst({ where: { id: personaId, isAdmin: false } });
  return user?.id ?? null;
}

/**
 * DEMO SEAM: the id to mint an admin session for the IT console. In production this is
 * replaced by real login — the route guards that call getAdminId() do not change.
 */
export async function resolveDemoAdminId(): Promise<string | null> {
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  return admin?.id ?? null;
}
