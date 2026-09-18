"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { isAbortError, useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Ban, Globe, Monitor, ShieldOff, Users } from "lucide-react";
import {
  BLOCK_DURATIONS,
  BLOCK_REASON_LABELS,
  BlockReasons,
  isBlockableIp,
  type BlockReason,
  type BlockedIpRow,
} from "@/lib/ipBlocks";

export type SessionRow = {
  id: string;
  name: string;
  email: string;
  miuId: string | null;
  role: string;
  status: string;
  academicYear: number | null;
  lastSeenAt: string | null;
  ip: string | null;
  userAgent: string | null;
};

/** Turns a user-agent string into something an admin can scan. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : "Unknown browser";

  const platform = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";

  return platform ? `${browser} on ${platform}` : browser;
}

function relative(iso: string | null) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function expiryLabel(row: BlockedIpRow) {
  if (!row.expiresAt) return "Permanent";
  const end = new Date(row.expiresAt);
  return row.active ? `Until ${end.toLocaleString()}` : `Lapsed ${end.toLocaleDateString()}`;
}

/**
 * Owns the block list for the whole page.
 *
 * The activity feed, the sessions panel and the blocked list all act on the same
 * data, so one hook holds it rather than three copies drifting apart.
 */
export function useIpBlocks() {
  const [blocks, setBlocks] = React.useState<BlockedIpRow[]>([]);
  const [yourIp, setYourIp] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ip-blocks", { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error ?? "Failed to load the block list");
        return;
      }
      setBlocks((j?.items ?? []) as BlockedIpRow[]);
      setYourIp(j?.yourIp ?? null);
      setError(null);
    } catch {
      setError("Network error. Check your connection and try again.");
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const block = React.useCallback(
    async (input: { ip: string; reason: BlockReason; hours: number | null; note: string }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/ip-blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ip: input.ip,
            reason: input.reason,
            hours: input.hours,
            note: input.note.trim() || undefined,
          }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          setError(j?.error ?? "Could not block that address");
          return false;
        }
        await reload();
        return true;
      } catch {
        setError("Network error. Check your connection and try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  const unblock = React.useCallback(
    async (row: BlockedIpRow) => {
      if (!window.confirm(`Lift the block on ${row.ip}?`)) return;

      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/ip-blocks/${row.id}`, { method: "DELETE" });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          setError(j?.error ?? "Could not lift that block");
          return;
        }
        await reload();
      } catch {
        setError("Network error. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  const activeIps = React.useMemo(
    () => new Set(blocks.filter((b) => b.active).map((b) => b.ip)),
    [blocks]
  );

  return { blocks, activeIps, yourIp, error, busy, block, unblock, reload };
}

export function BlockIpDialog({
  ip,
  open,
  onOpenChange,
  onConfirm,
  busy,
  yourIp,
}: {
  ip: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { ip: string; reason: BlockReason; hours: number | null; note: string }) => void;
  busy: boolean;
  yourIp: string | null;
}) {
  const [reason, setReason] = React.useState<BlockReason>(BlockReasons.BruteForce);
  const [hours, setHours] = React.useState<string>("24");
  const [note, setNote] = React.useState("");

  // A fresh dialog every time, so yesterday's note is not attached to today's block.
  React.useEffect(() => {
    if (open) {
      setReason(BlockReasons.BruteForce);
      setHours("24");
      setNote("");
    }
  }, [open, ip]);

  if (!ip) return null;

  const isSelf = Boolean(yourIp && yourIp === ip);
  const blockable = isBlockableIp(ip);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5 text-risk" />
            Block {ip}
          </DialogTitle>
          <DialogDescription>
            Every request from this address is refused with a 403 — pages, the API and sign-in alike.
          </DialogDescription>
        </DialogHeader>

        {isSelf ? (
          <p className="mt-4 rounded-2xl bg-risk/10 px-4 py-3 text-sm font-semibold text-risk">
            This is your own address. Blocking it would lock you out of this console, so it is not allowed.
          </p>
        ) : !blockable ? (
          <p className="mt-4 rounded-2xl bg-risk/10 px-4 py-3 text-sm font-semibold text-risk">
            That is not an address this can act on. Requests with no forwarding header all look the same, so
            blocking them would take the whole site down.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-bold text-foreground/60">Reason</span>
              <Select value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
                {Object.entries(BLOCK_REASON_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold text-foreground/60">For how long</span>
              <Select value={hours} onChange={(e) => setHours(e.target.value)}>
                {BLOCK_DURATIONS.map((d) => (
                  <option key={d.label} value={d.hours === null ? "" : String(d.hours)}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold text-foreground/60">Note (optional)</span>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What you saw in the log…"
              />
            </label>
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || isSelf || !blockable}
            onClick={() => onConfirm({ ip, reason, hours: hours ? Number(hours) : null, note })}
          >
            {busy ? "Blocking…" : "Block this address"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BlockedIpsCard({
  blocks,
  onUnblock,
  busy,
}: {
  blocks: BlockedIpRow[];
  onUnblock: (row: BlockedIpRow) => void;
  busy: boolean;
}) {
  const active = blocks.filter((b) => b.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldOff className="h-5 w-5 text-risk" />
          Blocked addresses
        </CardTitle>
        <CardDescription>
          {active.length} in force
          {blocks.length > active.length ? ` · ${blocks.length - active.length} lapsed` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {blocks.length === 0 ? (
          <p className="text-sm text-foreground/70">
            Nothing blocked. Use the Block button on a log entry to add one.
          </p>
        ) : (
          <ul className="space-y-2">
            {blocks.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-background p-3">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold">{row.ip}</span>
                    {row.active ? (
                      <Badge tone="risk">Blocked</Badge>
                    ) : (
                      <Badge tone="neutral">Lapsed</Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-foreground/55">
                    {BLOCK_REASON_LABELS[row.reason]} · {expiryLabel(row)}
                    {row.createdByName ? ` · by ${row.createdByName}` : ""}
                  </span>
                  {row.note ? (
                    <span className="mt-0.5 block truncate text-xs text-foreground/45">{row.note}</span>
                  ) : null}
                </span>

                <Button variant="ghost" size="sm" onClick={() => onUnblock(row)} disabled={busy}>
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ActiveSessionsCard({
  onBlockIp,
  activeIps,
}: {
  onBlockIp: (ip: string) => void;
  activeIps: Set<string>;
}) {
  const [items, setItems] = React.useState<SessionRow[]>([]);
  const [sharedIps, setSharedIps] = React.useState<{ ip: string; accounts: number }[]>([]);
  const [minutes, setMinutes] = React.useState("15");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        // no-cache rather than no-store: every poll still reaches the server,
        // but an unchanged window comes back as a 304 with no body.
        const res = await fetch(`/api/admin/sessions?minutes=${minutes}`, {
          cache: "no-cache",
          signal,
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          setError(j?.error ?? "Failed to load sessions");
          return;
        }
        setItems((j?.items ?? []) as SessionRow[]);
        setSharedIps(j?.sharedIps ?? []);
        setError(null);
      } catch (err) {
        // An aborted poll is this component unmounting or the window length
        // changing, not a connection problem - saying so would be a lie.
        if (isAbortError(err)) return;
        setError("Network error. Check your connection and try again.");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [minutes]
  );

  // Refreshed on a timer so the panel is worth leaving open during an incident,
  // but only while someone is actually looking at it.
  useVisiblePoll(load, 30_000);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Users className="h-5 w-5 text-primary" />
          Signed in recently
        </CardTitle>
        <CardDescription>
          Accounts active in the last {minutes} minutes, with the address they were last seen from.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={minutes} onChange={(e) => setMinutes(e.target.value)} className="sm:max-w-48">
          <option value="15">Last 15 minutes</option>
          <option value="60">Last hour</option>
          <option value="1440">Last 24 hours</option>
        </Select>

        {error ? <p className="text-sm font-semibold text-risk">{error}</p> : null}

        {sharedIps.length > 0 ? (
          <div className="rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3">
            <p className="text-sm font-bold">One address, several accounts</p>
            <p className="mt-1 text-xs text-foreground/70">
              Normal on a shared campus machine — worth a look if it is not.
            </p>
            <ul className="mt-2 space-y-1">
              {sharedIps.map((s) => (
                <li key={s.ip} className="text-xs">
                  <span className="font-mono font-bold">{s.ip}</span> — {s.accounts} accounts
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <p className="text-sm text-foreground/70">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-foreground/70">Nobody has been active in this window.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((row) => {
              const blocked = row.ip ? activeIps.has(row.ip) : false;

              return (
                <li key={row.id} className="flex flex-wrap items-start gap-3 rounded-xl bg-background p-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold">{row.name}</span>
                      {row.miuId ? (
                        <span className="text-xs text-foreground/55">{row.miuId}</span>
                      ) : null}
                      {row.role === "admin" ? <Badge tone="success">Admin</Badge> : null}
                      {row.status !== "active" ? <Badge tone="warning">{row.status}</Badge> : null}
                    </span>

                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground/55">
                      <span className="inline-flex items-center gap-1">
                        <Globe className="h-3.5 w-3.5" />
                        <span className="font-mono">{row.ip ?? "unknown"}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Monitor className="h-3.5 w-3.5" />
                        {describeAgent(row.userAgent)}
                      </span>
                      <span>{relative(row.lastSeenAt)}</span>
                    </span>
                  </span>

                  {row.ip && row.role !== "admin" ? (
                    blocked ? (
                      <Badge tone="risk">Blocked</Badge>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => onBlockIp(row.ip!)}>
                        <Ban className="h-4 w-4 text-risk" />
                      </Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
