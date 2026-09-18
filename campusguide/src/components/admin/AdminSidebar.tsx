"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { logoutEverywhere } from "@/lib/logout";
import { useVisiblePoll } from "@/lib/useVisiblePoll";
import {
  Activity,
  ArrowLeft,
  Database,
  Gauge,
  GraduationCap,
  Library,
  LogOut,
  Menu,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Users,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { SIGN_OUT_CONFIRM } from "@/lib/session";

type Item = {
  href: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  /** Overview is the section root, so it must match exactly or every page lights up. */
  exact?: boolean;
};

const ITEMS: Item[] = [
  { href: "/admin", label: "Overview", hint: "Activity and totals", icon: <Gauge className="h-5 w-5" />, exact: true },
  { href: "/admin/verification", label: "Verification", hint: "Approve new students", icon: <ShieldCheck className="h-5 w-5" /> },
  { href: "/admin/users", label: "Users", hint: "Inspect, ban, delete", icon: <Users className="h-5 w-5" /> },
  { href: "/admin/activity", label: "Activity log", hint: "Everything that happened", icon: <Activity className="h-5 w-5" /> },
  { href: "/admin/resources", label: "File storage", hint: "Folders and uploads", icon: <Library className="h-5 w-5" /> },
  { href: "/admin/teams", label: "Teams board", hint: "Posts and stale clean-up", icon: <UsersRound className="h-5 w-5" /> },
  { href: "/admin/videos", label: "Videos", hint: "YouTube courses", icon: <Video className="h-5 w-5" /> },
  { href: "/admin/usage", label: "Usage", hint: "What students open", icon: <TrendingUp className="h-5 w-5" /> },
  { href: "/admin/rooms", label: "Rooms", hint: "Map coordinates", icon: <Database className="h-5 w-5" /> },
  { href: "/admin/controls", label: "Controls", hint: "Lock areas for students", icon: <SlidersHorizontal className="h-5 w-5" /> },
];

function useActive() {
  const pathname = usePathname();
  return React.useCallback(
    (item: Item) =>
      item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`),
    [pathname]
  );
}

function PendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-warning px-2 py-0.5 text-xs font-extrabold text-background">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Deliberately louder than PendingBadge — red rather than amber, and it pulses.
 * A verification queue can wait; a break-in attempt should catch the eye from
 * whatever page the admin is on.
 */
function AlertBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      title={`${count} open security alert${count === 1 ? "" : "s"}`}
      className="ml-auto inline-flex min-w-6 shrink-0 animate-pulse items-center justify-center rounded-full bg-risk px-2 py-0.5 text-xs font-extrabold text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavItems({ pending, alerts, onNavigate }: { pending: number; alerts: number; onNavigate?: () => void }) {
  const isActive = useActive();

  return (
    <nav className="flex flex-col gap-1.5">
      {ITEMS.map((item) => {
        const active = isActive(item);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-2xl px-4 py-3 transition-colors",
              active
                ? "bg-primary text-white shadow-sm"
                : "text-foreground/75 hover:bg-panel/60 hover:text-foreground"
            )}
          >
            <span className={cn("shrink-0", active ? "text-white" : "text-foreground/55")}>{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold leading-tight">{item.label}</span>
              <span
                className={cn(
                  "block truncate text-[11px] leading-tight",
                  active ? "text-white/70" : "text-foreground/45"
                )}
              >
                {item.hint}
              </span>
            </span>
            {item.href === "/admin/verification" ? <PendingBadge count={pending} /> : null}
            {item.href === "/admin" ? <AlertBadge count={alerts} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({ pending, alerts, onNavigate }: { pending: number; alerts: number; onNavigate?: () => void }) {
  const { data } = useSession();

  return (
    <>
      <div className="shrink-0 border-b border-foreground/10 px-5 py-5">
        <Link href="/admin" onClick={onNavigate} className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary text-white shadow-sm">
            <GraduationCap className="h-6 w-6" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-extrabold tracking-tight">CampusGuide</span>
            <span className="block text-xs font-semibold text-foreground/50">Admin console</span>
          </span>
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <p className="px-4 pb-2 text-xs font-extrabold uppercase tracking-wider text-foreground/40">Manage</p>
        <NavItems pending={pending} alerts={alerts} onNavigate={onNavigate} />
      </div>

      <div className="shrink-0 space-y-2 border-t border-foreground/10 p-3">
        {data?.user ? (
          <div className="rounded-2xl bg-background px-4 py-3">
            <p className="truncate text-sm font-bold">{data.user.name ?? "Admin"}</p>
            <p className="truncate text-xs text-foreground/50">{data.user.email}</p>
          </div>
        ) : null}

        <Link href="/dashboard" onClick={onNavigate} className="block">
          <Button variant="ghost" className="h-11 w-full justify-start">
            <ArrowLeft className="h-4 w-4" />
            Back to site
          </Button>
        </Link>

        <Button
          variant="secondary"
          className="h-11 w-full justify-start"
          onClick={() => {
                if (window.confirm(SIGN_OUT_CONFIRM)) void logoutEverywhere("/");
              }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </>
  );
}

/** Polls the queue count so the badge is current from any admin page. */
function usePendingCount() {
  const [pending, setPending] = React.useState(0);

  const load = React.useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/stats", { cache: "no-cache", signal });
      if (!res.ok) return;
      const j = await res.json();
      setPending(Number(j?.users?.pending ?? 0));
    } catch {
      // A missing badge is not worth surfacing an error for, and an aborted
      // poll lands here too.
    }
  }, []);

  useVisiblePoll(load, 60_000);

  return pending;
}

/**
 * Open security alerts, polled faster than the queue badge so an attack in
 * progress shows up on whatever admin page you happen to be looking at.
 */
function useAlertCount() {
  const [count, setCount] = React.useState(0);

  const load = React.useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/alerts", { cache: "no-cache", signal });
      if (!res.ok) return;
      const j = await res.json();
      setCount(Number(j?.openCount ?? 0));
    } catch {
      // Same as the queue badge: a dropped or aborted poll is not worth an error.
    }
  }, []);

  useVisiblePoll(load, 20_000);

  return count;
}

export function AdminSidebar() {
  const pending = usePendingCount();
  const alerts = useAlertCount();
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      {/* Fixed rail. The admin area has no site navbar, so this owns the full height. */}
      {/* Narrower below xl so the content column isn't paying 320px for a rail
          of six links on a 1440-wide laptop. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r border-foreground/10 bg-nav lg:flex xl:w-80">
        <SidebarBody pending={pending} alerts={alerts} />
      </aside>

      {/* Compact top bar replaces the site navbar below lg */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-foreground/10 bg-nav px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4 lg:hidden">
        <Button
          variant="secondary"
          className="h-10 w-10 shrink-0 rounded-2xl p-0"
          onClick={() => setOpen(true)}
          aria-label="Open admin menu"
          aria-expanded={open}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-primary text-white">
            <GraduationCap className="h-5 w-5" />
          </span>
          <span className="truncate text-sm font-extrabold tracking-tight">Admin console</span>
        </span>
        <PendingBadge count={pending} />
      </header>

      {open ? (
        <div className="lg:hidden">
          <button
            type="button"
            className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm"
            aria-label="Close admin menu"
            onClick={() => setOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Admin navigation"
            className="fixed inset-y-0 left-0 z-[60] flex w-[min(88vw,20rem)] flex-col bg-nav shadow-2xl"
          >
            <Button
              variant="ghost"
              className="absolute right-3 top-4 h-9 w-9 rounded-2xl p-0"
              onClick={() => setOpen(false)}
              aria-label="Close admin menu"
            >
              <X className="h-5 w-5" />
            </Button>
            <SidebarBody pending={pending} alerts={alerts} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
