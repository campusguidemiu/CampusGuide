import { z } from "zod";
import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User } from "@/server/models/User";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { requireRole } from "@/server/security/requireRole";
import { noStoreJson } from "@/server/httpCache";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "@/server/security/passwords";
import { Roles } from "@/server/roles";
import { isDuplicateKeyError } from "@/server/mongoErrors";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/lib/activityActions";
import { MIU_ID_HINT, PHONE_HINT, isValidMiuId, normalizeMiuId, normalizePhone } from "@/lib/miu";

const MAX_LIMIT = 100;

const querySchema = z.object({
  status: z.enum([AccountStatuses.Pending, AccountStatuses.Active, AccountStatuses.Banned]).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function serializeUser(doc: any) {
  return {
    id: String(doc._id),
    name: doc.name as string,
    email: doc.email as string,
    miuId: doc.miuId ?? null,
    phone: doc.phone ?? null,
    role: doc.role as string,
    // Accounts predating verification have no status; they are established users.
    status: (doc.status as string) ?? AccountStatuses.Active,
    academicYear: doc.academicYear ?? null,
    lastSeenAt: doc.lastSeenAt instanceof Date ? doc.lastSeenAt.toISOString() : null,
    verifiedAt: doc.verifiedAt instanceof Date ? doc.verifiedAt.toISOString() : null,
    bannedAt: doc.bannedAt instanceof Date ? doc.bannedAt.toISOString() : null,
    banReason: doc.banReason ?? null,
    rejectionReason: doc.rejectionReason ?? null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : null,
  };
}

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req.headers, "admin:users:get");
  if (limited) return limited;

  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) return noStoreJson({ error: "Invalid query" }, 400);

  const filter: Record<string, unknown> = {};

  if (parsed.data.status === AccountStatuses.Active) {
    // Legacy rows have no status field at all but are active in every real sense.
    filter.$or = [{ status: AccountStatuses.Active }, { status: { $exists: false } }];
  } else if (parsed.data.status) {
    filter.status = parsed.data.status;
  }

  const q = parsed.data.q?.trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const search = [{ name: rx }, { email: rx }, { miuId: rx }, { phone: rx }];
    // Don't clobber the status filter above.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: search }];
      delete filter.$or;
    } else {
      filter.$or = search;
    }
  }

  await connectToDatabase();
  const users = await User.find(filter)
    .sort({ createdAt: -1 })
    .limit(parsed.data.limit ?? 50)
    .lean();

  return noStoreJson({ items: users.map(serializeUser) });
}

/**
 * Creates an account directly, with any role.
 *
 * Deliberately different from public registration: an admin vouches for the
 * person, so the account is created Active and pre-verified rather than sitting
 * in the ID-photo queue. MIU identity rules are also relaxed — staff and test
 * accounts legitimately have no student ID.
 */
const createSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(60),
    email: z.string().trim().toLowerCase().email("Enter a valid email address").max(320),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(200)
      .regex(/[A-Z]/, "Password must include at least 1 uppercase letter")
      .regex(/[0-9]/, "Password must include at least 1 number"),
    role: z.enum([Roles.Student, Roles.Admin]),
    academicYear: z.number().int().min(1).max(4),
    miuId: z.string().trim().max(20).optional(),
    phone: z.string().trim().max(24).optional(),
    status: z
      .enum([AccountStatuses.Pending, AccountStatuses.Active, AccountStatuses.Banned])
      .optional()
      .default(AccountStatuses.Active),
  })
  .strict();

export async function POST(req: Request) {
  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  const limited = await enforceRateLimit(req.headers, "admin:users:post", {
    points: 30,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return noStoreJson({ error: parsed.error.issues?.[0]?.message ?? "Invalid input" }, 400);
  }

  const { name, email, password, role, academicYear, status } = parsed.data;

  // Student IDs are optional here, but must still be well formed and unique
  // when given — a malformed one would break sign-in by student ID.
  let miuId: string | undefined;
  if (parsed.data.miuId) {
    miuId = normalizeMiuId(parsed.data.miuId);
    if (!isValidMiuId(miuId)) return noStoreJson({ error: MIU_ID_HINT }, 400);
  }

  let phone: string | undefined;
  if (parsed.data.phone) {
    const normalized = normalizePhone(parsed.data.phone);
    if (!normalized) return noStoreJson({ error: PHONE_HINT }, 400);
    phone = normalized;
  }

  await connectToDatabase();

  const clash = await User.findOne(miuId ? { $or: [{ email }, { miuId }] } : { email })
    .select("email miuId")
    .lean();
  if (clash) {
    return noStoreJson(
      { error: clash.email === email ? "Email already in use" : "Student ID already registered" },
      409
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  let created;
  try {
    created = await User.create({
      email,
      name,
      passwordHash,
      role,
      academicYear,
      miuId,
      phone,
      status,
      // An admin creating the account *is* the verification step.
      verifiedAt: status === AccountStatuses.Active ? new Date() : undefined,
      verifiedBy: status === AccountStatuses.Active ? session.user.id : undefined,
      // Created on their behalf, so they have not personally agreed to anything.
      acceptedTermsAt: undefined,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return noStoreJson({ error: "An account with that email or student ID already exists" }, 409);
    }
    throw err;
  }

  void logActivity({
    action: ActivityActions.UserCreate,
    actor: { id: session.user.id, name: session.user.name },
    targetId: String(created._id),
    targetType: "user",
    targetLabel: `${created.name} (${created.email})`,
    meta: { role, status },
    headers: req.headers,
  });

  return noStoreJson({ user: serializeUser(created.toObject()) }, 201);
}
