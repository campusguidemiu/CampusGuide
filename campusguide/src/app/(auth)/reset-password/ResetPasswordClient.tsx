"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";

export function ResetPasswordClient() {
  const search = useSearchParams();
  const token = search.get("token") ?? "";

  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "This reset link is invalid or has expired.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full border-foreground/10 bg-panel/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          Choose a new password
        </CardTitle>
        <CardDescription>Pick a strong password you don&apos;t use anywhere else.</CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground/80">
              Your password has been reset and any old sessions were signed out. You can now sign in.
            </p>
            <Link className="text-sm font-semibold text-primary hover:underline" href="/login">
              Go to sign in
            </Link>
          </div>
        ) : !token ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-risk">This link is missing its reset token.</p>
            <Link className="text-sm font-semibold text-primary hover:underline" href="/forgot-password">
              Request a new reset link
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-semibold">New password</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              <p className="text-xs text-foreground/60">
                At least 8 characters, with an uppercase letter and a number.
              </p>
            </div>
            {error ? <p className="text-sm font-semibold text-risk">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={loading}>
              <KeyRound className="h-4 w-4" />
              {loading ? "Resetting…" : "Reset password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
