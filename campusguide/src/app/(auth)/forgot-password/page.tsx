import { Suspense } from "react";
import { ForgotPasswordClient } from "./ForgotPasswordClient";

export const metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<p className="text-sm text-foreground/70">Loading…</p>}>
      <ForgotPasswordClient />
    </Suspense>
  );
}
