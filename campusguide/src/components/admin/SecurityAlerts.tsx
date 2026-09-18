"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  ALERT_LABELS,
  SEVERITY_TONES,
  type AlertSeverity,
  type AlertType,
} from "@/lib/alerts";

export type Alert = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  subject: string;
  subjectLabel: string | null;
  userId: string | null;
  count: number;
  message: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

/** How often the dashboard re-checks. Short enough to feel immediate. */
const POLL_MS = 20_000;

function relative(iso: string | null) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SecurityAlerts() {
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  // The signal is optional because the failed-acknowledge path re-reads the
  // list outside the poll loop, where there is nothing to abort against.
  const load = React.useCallback(async (signal?: AbortSignal) => {
    try {
      // no-cache rather than no-store: still revalidated on every poll, but the
      // server can answer 304 instead of resending an unchanged alert list.
      const res = await fetch("/api/admin/alerts", { cache: "no-cache", signal });
      if (!res.ok) return;
      const j = await res.json();
      setAlerts((j.alerts ?? []) as Alert[]);
    } catch {
      // A dropped or aborted poll is not worth surfacing; the next one catches up.
    } finally {
      setLoaded(true);
    }
  }, []);

  // Pauses on a hidden tab and refreshes on return - see useVisiblePoll.
  useVisiblePoll(load, POLL_MS);

  async function acknowledge(id: string) {
    setBusyId(id);
    // Optimistic: the row disappears at once, and a failed request restores it
    // on the next poll two ticks later at worst.
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch("/api/admin/alerts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      void load();
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded) return null;

  if (alerts.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-success/15 text-success">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold">Nothing suspicious</p>
            <p className="text-xs text-foreground/60">
              Failed sign-ins, rate-limit abuse and deletion bursts all raise an alert here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const worst = alerts.some((a) => a.severity === "high");

  return (
    <Card className={worst ? "border-risk/40" : "border-warning/30"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className={worst ? "h-5 w-5 text-risk" : "h-5 w-5 text-warning"} />
          Suspicious activity
          <Badge tone={worst ? "risk" : "warning"}>{alerts.length}</Badge>
        </CardTitle>
        <CardDescription>
          Newest first. Acknowledging clears it from here but keeps it in the record.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-2">
        {alerts.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-start gap-3 rounded-xl border border-foreground/10 bg-background p-3"
          >
            <Badge tone={SEVERITY_TONES[a.severity]}>{a.severity}</Badge>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{ALERT_LABELS[a.type]}</p>
              <p className="text-sm text-foreground/75">{a.message}</p>
              <p className="mt-1 text-xs text-foreground/55">
                {a.subjectLabel ?? a.subject} · {relative(a.lastSeenAt)}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {a.userId ? (
                <Link href={`/admin/users?user=${a.userId}`}>
                  <Button variant="ghost" size="sm">
                    Inspect
                  </Button>
                </Link>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                disabled={busyId === a.id}
                onClick={() => acknowledge(a.id)}
              >
                <Check className="h-4 w-4" />
                Got it
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
