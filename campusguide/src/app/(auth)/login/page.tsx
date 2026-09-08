import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/security/requireSession";
import { Toast } from "@/components/ui/toast";
import { LoginClient } from "./LoginClient";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (session) redirect("/dashboard");

  const query = await searchParams;

  /**
   * A `next` param means the visitor did not come here on purpose — they asked
   * for a page and were sent back. Both routes into that state set it: the navbar
   * gates its links while signed out, and the proxy redirects anyone who types a
   * protected URL straight in.
   *
   * Decided here rather than in the client component so the notice is in the
   * server-rendered HTML. Raised from a mount effect it never survived — see the
   * note in components/ui/toast.tsx.
   */
  const sentBack = typeof query.next === "string" && query.next.trim().length > 0;

  return (
    <>
      {sentBack ? <Toast message="Sign in first to open that page." /> : null}

      <Suspense fallback={<p className="text-sm text-foreground/70">Loading…</p>}>
        <LoginClient />
      </Suspense>

      {/*
        Self-service reset (pentest Finding 3). Replaces the old "message me on
        WhatsApp" flow, which left no audit trail and made the developer a
        social-engineering target.
      */}
      <p className="mt-4 text-center text-sm text-foreground/70">
        Forgot your password?{" "}
        <a
          href="/forgot-password"
          className="font-semibold text-primary underline-offset-4 hover:underline"
        >
          Reset it here
        </a>
        .
      </p>
    </>
  );
}
