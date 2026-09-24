import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AccountStatuses, User } from "../src/server/models/User";
import { Room } from "../src/server/models/Room";
import { TeamPost } from "../src/server/models/TeamPost";
import { Roles } from "../src/server/roles";
import { TeamDifficulties, TeamPostKinds, TeamPostStatuses } from "../src/lib/teams";

/**
 * Schema-level guarantees, checked with `validateSync()` so no database is
 * involved.
 *
 * These are the constraints the API routes lean on and never re-check: a route
 * that trusts `status` to be one of three values, or `x`/`y` to be inside the
 * map image, is only correct because the schema says so. A dropped `required`
 * or a widened `enum` is invisible until bad data is already stored.
 */

const validUser = () => ({
  email: "student@miuegypt.edu.eg",
  name: "Test Student",
  passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
  academicYear: 2,
});

const errorsFor = (doc: mongoose.Document) => doc.validateSync()?.errors ?? {};

// ------------------------------------------------------------------ User

test("a minimal valid user passes validation", () => {
  assert.equal(new User(validUser()).validateSync(), undefined);
});

test("a new account defaults to pending, not active", () => {
  // The entire verification queue depends on this default. If it flipped to
  // active, every self-registered account would skip the ID check.
  assert.equal(new User(validUser()).status, AccountStatuses.Pending);
});

test("a new account defaults to the student role", () => {
  assert.equal(new User(validUser()).role, Roles.Student);
});

test("email, name, passwordHash and academicYear are all required", () => {
  const errors = errorsFor(new User({}));
  for (const field of ["email", "name", "passwordHash", "academicYear"]) {
    assert.ok(errors[field], `${field} should be required`);
  }
});

test("status is constrained to the three known values", () => {
  for (const status of Object.values(AccountStatuses)) {
    assert.equal(errorsFor(new User({ ...validUser(), status }))["status"], undefined);
  }
  assert.ok(
    errorsFor(new User({ ...validUser(), status: "deleted" }))["status"],
    "an unknown status must be rejected — the guards only handle three",
  );
});

test("role is constrained to student or admin", () => {
  assert.ok(errorsFor(new User({ ...validUser(), role: "superadmin" }))["role"]);
  for (const role of Object.values(Roles)) {
    assert.equal(errorsFor(new User({ ...validUser(), role }))["role"], undefined);
  }
});

test("academicYear is held to 1–4", () => {
  for (const year of [0, 5, -1]) {
    assert.ok(errorsFor(new User({ ...validUser(), academicYear: year }))["academicYear"], `year ${year}`);
  }
  for (const year of [1, 2, 3, 4]) {
    assert.equal(errorsFor(new User({ ...validUser(), academicYear: year }))["academicYear"], undefined);
  }
});

test("the reset-token fields hold a hash and an expiry, never a raw token", () => {
  // lib/resetToken.ts stores only the SHA-256 hash. A field literally named
  // `resetToken` appearing here would mean the raw token got persisted.
  const paths = Object.keys(User.schema.paths);
  assert.ok(paths.includes("resetTokenHash"));
  assert.ok(paths.includes("resetTokenExpiresAt"));
  assert.ok(!paths.includes("resetToken"), "the raw reset token must never be a schema field");
});

test("the session revocation cut-off is on the schema", () => {
  // requireSession compares every token's mint time against this; without the
  // field, logout-everywhere silently stops revoking anything.
  assert.ok(Object.keys(User.schema.paths).includes("sessionsValidFrom"));
});

test("miuId is sparse so several accounts can have none", () => {
  // Without sparse, every admin without a student ID collides on a single null.
  const miuId = User.schema.path("miuId") as any;
  assert.equal(miuId.options.sparse, true);
  assert.equal(miuId.options.unique, true);
});

// ------------------------------------------------------------------ Room

test("a valid room passes validation", () => {
  assert.equal(
    new Room({ roomCode: "204", building: "T", floor: 2, x: 0.25, y: 0.75 }).validateSync(),
    undefined,
  );
});

test("map coordinates are constrained to the 0–1 image space", () => {
  // x/y are fractions of the map image. A value outside this range puts a pin
  // off the map entirely, which renders as an invisible or clipped marker.
  for (const [x, y] of [[-0.1, 0.5], [1.1, 0.5], [0.5, -0.01], [0.5, 1.000001]]) {
    const errors = errorsFor(new Room({ roomCode: "X", building: "T", floor: 1, x, y }));
    assert.ok(errors["x"] || errors["y"], `(${x}, ${y}) should be rejected`);
  }
});

test("the 0 and 1 corners of the map are valid", () => {
  for (const [x, y] of [[0, 0], [1, 1], [0, 1], [1, 0]]) {
    assert.equal(
      new Room({ roomCode: "X", building: "T", floor: 1, x, y }).validateSync(),
      undefined,
      `(${x}, ${y}) is a legitimate corner`,
    );
  }
});

test("every room field is required", () => {
  const errors = errorsFor(new Room({}));
  for (const field of ["roomCode", "building", "floor", "x", "y"]) {
    assert.ok(errors[field], `${field} should be required`);
  }
});

// -------------------------------------------------------------- TeamPost

const validPost = () => ({
  ownerId: new mongoose.Types.ObjectId(),
  ownerName: "Test Student",
  kind: TeamPostKinds.NeedsMembers,
  title: "Looking for two more",
  subject: "Software Engineering",
  contactPhone: "+201234567890",
});

test("a valid team post passes validation", () => {
  assert.equal(new TeamPost(validPost()).validateSync(), undefined);
});

test("a team post defaults to open and medium difficulty", () => {
  const post = new TeamPost(validPost());
  assert.equal(post.status, TeamPostStatuses.Open);
  assert.equal(post.difficulty, TeamDifficulties.Medium);
  assert.equal(post.currentMembers, 1);
  assert.equal(post.contactWhatsapp, true);
});

test("a team post without a contact number is rejected", () => {
  // Contact happens off-platform; a post with no number is unreachable and
  // would sit on the board forever.
  const withoutPhone: Partial<ReturnType<typeof validPost>> = validPost();
  delete withoutPhone.contactPhone;

  assert.ok(errorsFor(new TeamPost(withoutPhone))["contactPhone"]);
});

test("the owner, kind, title and subject are all required", () => {
  const errors = errorsFor(new TeamPost({}));
  for (const field of ["ownerId", "ownerName", "kind", "title", "subject", "contactPhone"]) {
    assert.ok(errors[field], `${field} should be required`);
  }
});

test("kind, difficulty and status are constrained to their catalogs", () => {
  assert.ok(errorsFor(new TeamPost({ ...validPost(), kind: "needs_money" }))["kind"]);
  assert.ok(errorsFor(new TeamPost({ ...validPost(), difficulty: "impossible" }))["difficulty"]);
  assert.ok(errorsFor(new TeamPost({ ...validPost(), status: "archived" }))["status"]);
});

test("member counts are held to a sane range", () => {
  for (const count of [0, 21, -3]) {
    assert.ok(
      errorsFor(new TeamPost({ ...validPost(), currentMembers: count }))["currentMembers"],
      `currentMembers ${count}`,
    );
  }
});

test("skillsNeeded defaults to an empty array, never undefined", () => {
  // The teams page maps over this directly.
  assert.deepEqual(new TeamPost(validPost()).skillsNeeded, []);
});

// ------------------------------------------------------- registration hygiene

test("models are registered once, so repeated imports do not redefine them", () => {
  // The models use the `mongoose.models.X || mongoose.model(...)` guard. Without
  // it, a hot reload throws OverwriteModelError.
  assert.equal(mongoose.models.User, User);
  assert.equal(mongoose.models.Room, Room);
  assert.equal(mongoose.models.TeamPost, TeamPost);
});

test("timestamps are enabled on the collections the admin UI sorts by", () => {
  for (const model of [User, Room, TeamPost]) {
    const paths = Object.keys(model.schema.paths);
    assert.ok(paths.includes("createdAt"), `${model.modelName} has no createdAt`);
    assert.ok(paths.includes("updatedAt"), `${model.modelName} has no updatedAt`);
  }
});
