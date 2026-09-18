import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "@/server/security/passwords";
import { connectToDatabase } from "@/server/db";
import { User } from "@/server/models/User";
import { ActivityActions } from "@/server/models/ActivityLog";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { requireRole } from "@/server/security/requireRole";
import { logActivity } from "@/server/activity";
import { noStoreJson } from "@/server/httpCache";

/**
 * Issues a new password for an account and hands it back once.
 *
 * There is no self-service reset — no mail sender is wired up — so the sign-in
 * page tells students to ask the admin. This is the other half of that: the
 * admin presses a button and reads the new password back to them.
 *
 * The admin never chooses it. A person picking a password for someone else
 * picks a weak one, and a generated value is the same strength every time.
 */

/** 18 url-safe characters, the same shape the create-admin script issues. */
function randomPassword() {
  return crypto.randomBytes(14).toString("base64url").slice(0, 18);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Tight: resetting passwords in bulk is not a thing anyone legitimately does.
  const limited = await enforceRateLimit(req.headers, "admin:users:password", {
    points: 10,
    duration: 60,
  });
  if (limited) return limited;

  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  const { id } = await params;
  if (!mongoose.isValidObjectId(id)) return noStoreJson({ error: "Invalid id" }, 400);

  await connectToDatabase();

  const user = await User.findById(id).select("name email");
  if (!user) return noStoreJson({ error: "Not found" }, 404);

  const password = randomPassword();
  // Cost 12, matching registration and admin-created accounts.
  user.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await user.save();

  /**
   * The password is deliberately absent from the log. The activity trail is
   * readable by anyone with admin access and is kept indefinitely; recording
   * that a reset happened is the useful part, recording the credential itself
   * would just be storing a plaintext password in a second place.
   *
   * Existing sessions are left alone. JWTs do not carry the password, so a
   * reset does not sign the student out of a device they still have — which is
   * the honest behaviour to describe rather than a security hole to imply.
   */
  void logActivity({
    action: ActivityActions.UserPasswordReset,
    actor: { id: session.user?.id, name: session.user?.name },
    targetId: id,
    targetType: "user",
    targetLabel: user.name,
    headers: req.headers,
  });

  // Returned once and never stored anywhere readable. If the admin loses it
  // before passing it on, the fix is to press the button again.
  return noStoreJson({ password, name: user.name, email: user.email });
}
