"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import * as React from "react";

export function AppSessionProvider({
  children,
  session,
}: {
  children: React.ReactNode;
  session?: Session | null;
}) {
  // refetchOnWindowFocus defaults to true, which means every time a student
  // tabs back to the app - constantly, on a phone - the client refetches
  // /api/auth/session and burns another function invocation. Nothing here
  // depends on that being fresh: the (app) layout re-reads authoritative
  // account state server-side on every navigation, so a stale client session
  // can only affect what the navbar renders until the next page load.
  return (
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      {children}
    </SessionProvider>
  );
}
