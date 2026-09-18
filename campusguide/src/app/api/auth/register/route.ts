import { z } from "zod";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "@/server/security/passwords";
import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User } from "@/server/models/User";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { isDuplicateKeyError } from "@/server/mongoErrors";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/server/models/ActivityLog";
import {
  MIU_ID_HINT,
  PHONE_HINT,
  normalizeMiuEmail,
  normalizeMiuId,
  normalizePhone,
  validateMiuIdentity,
} from "@/lib/miu";
import { TERMS_VERSION } from "@/lib/terms";
import { isRequestCsrfSafe } from "@/lib/csrf";

// Messages here are shown verbatim on the register form, so they must read as
// guidance rather than zod's internal "Too small: expected string…" text.
const schema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(60, "Name is too long"),
  email: z.string().max(320, "Email is too long"),
  miuId: z.string().max(20, MIU_ID_HINT),
  phone: z.string().max(24, PHONE_HINT),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password is too long")
    .regex(/[A-Z]/, "Password must include at least 1 uppercase letter")
    .regex(/[0-9]/, "Password must include at least 1 number"),
  academicYear: z
    .number("Select your academic year")
    .int("Select your academic year")
    .min(1, "Academic year must be between 1 and 4")
    .max(4, "Academic year must be between 1 and 4"),
  // Enforced here, not just on the form. A checkbox the server does not check
  // is decoration — anyone posting straight to this endpoint would skip it, and
  // the stored consent record would be a lie.
  acceptTerms: z.literal(true, {
    error: "You must accept the rules and conditions to create an account",
  }),
});

function bad(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request) {
  // CSRF backstop (pentest Finding 2). This route lives under /api/auth, which
  // the proxy does not guard, so it carries its own same-origin check.
  const csrfSafe = isRequestCsrfSafe({
    method: "POST",
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    allowedHosts: [req.headers.get("host"), req.headers.get("x-forwarded-host")],
  });
  if (!csrfSafe) return bad("CSRF check failed", 403);

  // Stricter limits for spam-prone endpoint
  const limited = await enforceRateLimit(req.headers, "auth:register", { points: 5, duration: 60 });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return bad(parsed.error.issues?.[0]?.message ?? "Invalid input");
  }

  const email = normalizeMiuEmail(parsed.data.email);
  const miuId = normalizeMiuId(parsed.data.miuId);

  // Registration is restricted to MIU students, and the ID and university email
  // have to describe the same person.
  const identityError = validateMiuIdentity(miuId, email);
  if (identityError) return bad(identityError);

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return bad(PHONE_HINT);

  // Additional limiter keyed by ID to slow down repeated attempts.
  const limitedId = await enforceRateLimit(req.headers, "auth:register:id", {
    points: 3,
    duration: 60,
    identity: miuId,
  });
  if (limitedId) return limitedId;

  try {
    await connectToDatabase();
  } catch (err) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Database unavailable"
        : `Database unavailable: ${(err as any)?.message ?? "connection failed"}`;

    return bad(message, 503);
  }

  const exists = await User.findOne({ $or: [{ email }, { miuId }] }).select("email miuId").lean();
  if (exists) {
    return bad(exists.email === email ? "Email already in use" : "Student ID already registered", 409);
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

  let created;
  try {
    created = await User.create({
      email,
      miuId,
      phone,
      name: parsed.data.name,
      passwordHash,
      role: "student",
      academicYear: parsed.data.academicYear,
      // Consent is recorded at the moment of creation, with the version of the
      // wording that was in force.
      acceptedTermsAt: new Date(),
      acceptedTermsVersion: TERMS_VERSION,
      // Nobody gets in until an admin has seen their ID photo.
      status: AccountStatuses.Pending,
    });
  } catch (err) {
    // Two concurrent registrations can both pass the findOne check above.
    if (isDuplicateKeyError(err)) {
      return bad("An account with that email or student ID already exists", 409);
    }
    throw err;
  }

  await logActivity({
    action: ActivityActions.Register,
    actor: { id: String(created._id), name: created.name, miuId: created.miuId },
    targetId: String(created._id),
    targetType: "user",
    targetLabel: miuId,
    meta: { email, phone, academicYear: parsed.data.academicYear },
    headers: req.headers,
  });

  return new Response(JSON.stringify({ ok: true, status: AccountStatuses.Pending }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}
