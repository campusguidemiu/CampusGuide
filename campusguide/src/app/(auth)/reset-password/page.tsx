import { Suspense } from "react";
import { ResetPasswordClient } from "./ResetPasswordClient";

export const metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="text-sm text-foreground/70">Loading…</p>}>
      <ResetPasswordClient />
    </Suspense>
  );
}
