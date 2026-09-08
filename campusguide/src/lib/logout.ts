import { signOut } from "next-auth/react";

/**
 * Sign out for real (pentest Finding 1).
 *
 * NextAuth's `signOut()` on its own only clears the cookie in this browser. We
 * first tell the server to revoke every token for this account (stamping
 * `sessionsValidFrom`), so a token captured before logout stops working too —
 * then clear the local cookie and redirect as before.
 *
 * The server call is best-effort: if it fails (offline, say) we still clear the
 * local session rather than trapping the user on the page.
 */
export async function logoutEverywhere(callbackUrl = "/"): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Ignore — a failed revocation must not block the local sign-out below.
  }
  await signOut({ callbackUrl });
}
