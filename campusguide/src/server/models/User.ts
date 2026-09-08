import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import { Roles, type Role } from "@/server/roles";

export const AccountStatuses = {
  /** Registered, waiting for an admin to check their ID photo. Can sign in, but only sees the pending screen. */
  Pending: "pending",
  /** Verified student or admin. Full access. */
  Active: "active",
  /** Locked out. Rejected at the next authenticated request, not just at sign-in. */
  Banned: "banned",
} as const;

export type AccountStatus = (typeof AccountStatuses)[keyof typeof AccountStatuses];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(Roles), required: true, default: Roles.Student },
    academicYear: { type: Number, min: 1, max: 4, required: true },

    // MIU identity. Sparse so the seeded admin accounts — which predate this and
    // have no student ID — don't all collide on a single null in the unique index.
    miuId: { type: String, unique: true, sparse: true, index: true },
    phone: { type: String },

    status: {
      type: String,
      enum: Object.values(AccountStatuses),
      required: true,
      default: AccountStatuses.Pending,
      index: true,
    },
    verifiedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    bannedAt: { type: Date },
    banReason: { type: String },
    rejectionReason: { type: String },

    // Proof of consent. Stored with the version so the record says *which*
    // wording was agreed to — the text can change, what they accepted cannot.
    acceptedTermsAt: { type: Date },
    acceptedTermsVersion: { type: String },

    // Written at most once a minute per user; the source of the DAU/WAU/MAU counts.
    lastSeenAt: { type: Date, index: true },

    /**
     * Where the account was last used from, stamped alongside `lastSeenAt`.
     *
     * Only ever the most recent value — this is an operational aid for spotting
     * a shared or hijacked account, not a location history. Anything longer
     * lived belongs in the activity log, which already records an IP per action.
     */
    lastIp: { type: String, index: true },
    lastUserAgent: { type: String, maxlength: 400 },

    /**
     * Server-side session revocation cut-off (see `lib/session.ts`).
     *
     * Stamped whenever the account logs out or resets its password. Any session
     * token minted before this moment is refused by the request guards, even
     * though the JWT itself is still valid and unexpired. Absent means the
     * account has never logged out, so no token has been revoked.
     */
    sessionsValidFrom: { type: Date },

    /**
     * Self-service password reset. Only the SHA-256 hash of the outstanding
     * reset token is stored, never the token itself; both are cleared the moment
     * the token is used or a new one is issued. See `lib/resetToken.ts`.
     */
    resetTokenHash: { type: String },
    resetTokenExpiresAt: { type: Date },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema> & { role: Role; status: AccountStatus };

export const User: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc>) || mongoose.model<UserDoc>("User", userSchema);
