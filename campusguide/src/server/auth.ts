import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcrypt";
import { env } from "@/env";
import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User } from "@/server/models/User";
import { Roles } from "@/server/roles";
import { ActivityActions } from "@/server/models/ActivityLog";
import { logActivity } from "@/server/activity";
import { recordAuthFailure, recordSignInSuccess } from "@/server/security/alerts";
import { isValidMiuId, normalizeMiuId } from "@/lib/miu";
import {
  SESSION_MAX_AGE_SECONDS,
  isSessionExpired,
  sessionExpiryFrom,
} from "@/lib/session";
import { z } from "zod";

// Students know their student ID better than their university email, so either
// works. The field is still called `email` because that is what the sign-in form
// and NextAuth have always posted.
const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(8).max(200),
});

export const authOptions: NextAuthOptions = {
  secret: env.NEXTAUTH_SECRET,
  // The ceiling for the cookie and the JWT. The shorter, unticked lifetime is
  // enforced inside the token itself — see the `jwt` callback.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        rememberMe: { label: "Remember me", type: "checkbox" },
      },
      async authorize(raw, req) {
        // NextAuth hands us a bare request object here, not a fetch Headers, so
        // the address has to be read off the plain header bag.
        const headerBag = (req?.headers ?? {}) as Record<string, string | string[] | undefined>;
        const forwarded = headerBag["x-forwarded-for"];
        const realIp = headerBag["x-real-ip"];
        const ip =
          (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
          (Array.isArray(realIp) ? realIp[0] : realIp) ||
          undefined;

        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) {
          // Recorded rather than dropped. A guess shorter than the 8-character
          // minimum can never be a real password, but leaving it unlogged let an
          // attacker slip under the brute-force rule by guessing short.
          const attempted = typeof (raw as { email?: unknown } | undefined)?.email === "string"
            ? ((raw as { email: string }).email).trim().slice(0, 320)
            : "";
          if (attempted) {
            void recordAuthFailure({ kind: "bad_password", identifier: attempted, ip });
          }
          return null;
        }

        const identifier = parsed.data.email.trim();

        await connectToDatabase();

        // A student ID contains a slash and an email does not, so the shape of
        // the input decides which field to look in.
        const asMiuId = normalizeMiuId(identifier);
        const user = isValidMiuId(asMiuId)
          ? await User.findOne({ miuId: asMiuId }).lean()
          : await User.findOne({ email: identifier.toLowerCase() }).lean();

        if (!user) {
          // Someone probing for valid student IDs looks exactly like this.
          void recordAuthFailure({ kind: "unknown_account", identifier, ip });
          return null;
        }

        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) {
          void recordAuthFailure({
            kind: "bad_password",
            identifier,
            ip,
            userId: String(user._id),
            name: user.name,
          });
          return null;
        }

        // Banned accounts are turned away at the door. Pending ones are let in
        // deliberately — they need to reach the "send your ID" screen.
        if (user.status === AccountStatuses.Banned) {
          void recordAuthFailure({
            kind: "banned",
            identifier,
            ip,
            userId: String(user._id),
            name: user.name,
          });
          return null;
        }

        await logActivity({
          action: ActivityActions.SignIn,
          actor: { id: String(user._id), name: user.name, miuId: user.miuId },
          targetId: String(user._id),
          targetType: "user",
          headers: req?.headers ? new Headers(headerBag as Record<string, string>) : undefined,
        });

        void recordSignInSuccess({ userId: String(user._id), name: user.name, ip });

        // NextAuth hands credentials through as strings.
        const rememberMe = String((raw as { rememberMe?: unknown } | undefined)?.rememberMe) === "true";

        return {
          id: String(user._id),
          email: user.email,
          name: user.name,
          role: user.role ?? Roles.Student,
          academicYear: user.academicYear,
          rememberMe,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
        token.academicYear = (user as any).academicYear;
        // Stamped once, at sign-in. Ticking the box buys the longer window; the
        // cookie is issued for the ceiling either way, so this is what actually
        // decides when an unticked session stops working.
        (token as any).expiresAt = sessionExpiryFrom(Boolean((user as any).rememberMe));
        // When this token was minted. Compared against the account's
        // `sessionsValidFrom` cut-off on every guarded request so a logout or
        // password reset can revoke tokens minted before it — see
        // `isSessionRevoked` in `lib/session.ts`.
        (token as any).loginAt = Date.now();
      }

      // Past its own window: strip every identity claim rather than returning
      // the token unchanged. `sub` has to go too — the session callback reads
      // the user id from it, and a token that still carries one is still a
      // signed-in session as far as every guard downstream is concerned.
      //
      // Tokens issued before this shipped carry no `expiresAt` and are left
      // alone, so nobody is signed out by the deploy itself.
      if (isSessionExpired((token as any).expiresAt)) {
        return { expiresAt: (token as any).expiresAt } as typeof token;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.sub;
        (session.user as any).role = (token as any).role;
        (session.user as any).academicYear = (token as any).academicYear;
      }
      // The real cut-off for this session, which is shorter than the cookie's
      // own lifetime whenever "remember me" was left unticked. Exposed so the
      // app can tell a student when they will be asked to sign in again.
      (session as any).sessionExpiresAt = (token as any).expiresAt ?? null;
      // When the token was minted, so the request guard can test it against the
      // account's revocation cut-off (`requireSession`).
      (session as any).loginAt = (token as any).loginAt ?? null;
      return session;
    },
  },
};
