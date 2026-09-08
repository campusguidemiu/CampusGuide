/**
 * Activity action names.
 *
 * These live in `lib` rather than beside the Mongoose model so client
 * components (the admin activity filter) can import them without pulling
 * mongoose into the browser bundle.
 */
export const ActivityActions = {
  Register: "auth.register",
  SignIn: "auth.signin",
  /** A real server-side logout: the account's sessions were revoked. */
  SignOut: "auth.signout",
  /** A password reset was requested (a token was issued). */
  PasswordResetRequest: "auth.password_reset.request",
  /** A password reset was completed and outstanding sessions were revoked. */
  PasswordResetComplete: "auth.password_reset.complete",

  // Rejected sign-ins. Previously unrecorded — `authorize()` just returned
  // null — which left the most useful security signal invisible.
  SignInFailed: "auth.signin.failed",
  SignInUnknown: "auth.signin.unknown",
  SignInBanned: "auth.signin.banned",
  RateLimited: "abuse.rate_limited",

  FlagEnabled: "admin.flag.enable",
  FlagDisabled: "admin.flag.disable",
  AlertAcknowledged: "admin.alert.ack",

  VerifyApprove: "admin.user.verify",
  VerifyReject: "admin.user.reject",
  UserBan: "admin.user.ban",
  UserUnban: "admin.user.unban",
  UserDelete: "admin.user.delete",
  /** An admin edited an account's fields directly, rather than verifying or banning it. */
  UserUpdate: "admin.user.update",
  /** An admin issued a new password. The password itself is never logged. */
  UserPasswordReset: "admin.user.password_reset",

  ResourceCreate: "resource.create",
  ResourceUpdate: "resource.update",
  ResourceReplace: "resource.replace",
  ResourceDelete: "resource.delete",

  FolderCreate: "folder.create",
  FolderUpdate: "folder.update",
  FolderDelete: "folder.delete",

  ScheduleImport: "schedule.import",

  UserCreate: "admin.user.create",

  TeamPostCreate: "team.post.create",
  TeamPostDelete: "team.post.delete",

  /**
   * A deliberate bulk clear-out of stale posts from the admin dashboard.
   *
   * Kept distinct from TeamPostDelete on purpose: the mass-deletion alert counts
   * single deletes to catch a compromised account, and one intentional cleanup
   * of twenty old posts would otherwise raise a security alert against the admin
   * who pressed the button. One log entry records the whole sweep.
   */
  TeamPostPurge: "team.post.purge",

  IpBlocked: "security.ip.block",
  IpUnblocked: "security.ip.unblock",

  VideoCourseCreate: "video.course.create",
  VideoCourseUpdate: "video.course.update",
  VideoCourseDelete: "video.course.delete",
} as const;

export type ActivityAction = (typeof ActivityActions)[keyof typeof ActivityActions];
