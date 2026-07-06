import { NextResponse } from "next/server";
import {
  resolveDemoAdminId,
  signSession,
  ADMIN_COOKIE,
  SESSION_COOKIE_OPTS,
} from "@/lib/session";

// DEMO SEAM: mint the IT-console admin session. A single-browser split-screen demo can't
// have mutually-exclusive real logins for both the employee and the admin at once, so the
// console establishes its admin session here. In production this endpoint is replaced by
// real IdP/SSO login; the getAdminId() guard on every privileged mutation is unchanged, so
// swapping this mint is the only change needed to make the authz real.
export async function POST() {
  const adminId = await resolveDemoAdminId();
  if (!adminId) {
    return NextResponse.json({ error: "No admin user provisioned" }, { status: 500 });
  }
  const res = NextResponse.json({ ok: true, adminId });
  res.cookies.set(ADMIN_COOKIE, signSession(adminId), SESSION_COOKIE_OPTS);
  return res;
}
