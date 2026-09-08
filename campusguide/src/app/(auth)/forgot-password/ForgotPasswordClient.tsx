"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";

export function ForgotPasswordClient() {
  const [identifier, setIdentifier] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const [devLink, setDevLink] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setDevLink(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const body = await res.json().catch(() => ({}));
      // The server answers the same way whether or not the account exists, so we
      // never confirm to the visitor that an account was found.
      setDone(body?.message ?? "If an account matches, a password reset link has been issued.");
      if (typeof body?.devResetLink === "string") setDevLink(body.devResetLink);
    } catch {
      setDone("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full border-foreground/10 bg-panel/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          Reset your password
        </CardTitle>
        <CardDescription>
          Enter your student ID or university email and we&apos;ll issue a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground/80">{done}</p>
            {devLink ? (
              <p className="break-all rounded-2xl bg-background p-3 text-xs text-foreground/70">
                Dev only — email delivery is not configured, so here is the link:{" "}
                <a className="font-semibold text-primary underline" href={devLink}>
                  {devLink}
                </a>
              </p>
            ) : null}
            <Link className="text-sm font-semibold text-primary hover:underline" href="/login">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-semibold">Student ID or university email</label>
              <Input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                type="text"
                autoComplete="username"
                placeholder="2024/15832"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              <KeyRound className="h-4 w-4" />
              {loading ? "Sending…" : "Send reset link"}
            </Button>
            <div className="text-sm text-foreground/80">
              Remembered it?{" "}
              <Link className="font-semibold text-primary hover:underline" href="/login">
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
