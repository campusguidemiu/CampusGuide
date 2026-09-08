"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { logoutEverywhere } from "@/lib/logout";
import {
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  Library,
  LogIn,
  LogOut,
  MapPin,
  Menu,
  Shield,
  UserPlus,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { SIGN_OUT_CONFIRM } from "@/lib/session";
import { FlagKeys } from "@/lib/flags";

/**
 * Section matching, not exact matching: /admin/users should light up "Admin",
 * and signed-out links carry a ?next= query that an equality check would miss.
 */
function useIsActive() {
  const pathname = usePathname();

  return React.useCallback(
    (href: string) => {
      // Signed-out links are rewritten to /login?next=...; matching on /login
      // would highlight every gated item at once on the sign-in page.
      if (href.startsWith("/login?")) return false;
      const target = href.split("?")[0];
      if (target === "/") return pathname === "/";
      return pathname === target || pathname.startsWith(`${target}/`);
    },
    [pathname]
  );
}

/** Compact, text-only link for the top bar — icons there cost ~25px each. */
function BarLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-xl px-2.5 py-2 text-sm font-semibold whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "bg-primary text-white" : "text-foreground/75 hover:bg-panel/60 hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
}

/** Roomier link with an icon, for the slide-out drawer. */
function DrawerLink({
  href,
  icon,
  label,
  active,
  onNavigate,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors",
        active ? "bg-primary text-white" : "text-foreground/80 hover:bg-panel/60 hover:text-foreground"
      )}
    >
      <span className={cn("shrink-0", active ? "text-white" : "text-foreground/60")}>{icon}</span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

function loginRedirectHref(targetHref: string) {
  return `/login?next=${encodeURIComponent(targetHref)}`;
}

export function Navbar() {
  const { data } = useSession();
  const [openGpa, setOpenGpa] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const pathname = usePathname();
  const isActive = useIsActive();
  const authed = Boolean(data?.user);
  const isAdmin = authed && data?.user?.role === "admin";

  const gpaRef = React.useRef<HTMLDivElement>(null);

  const gate = React.useCallback(
    (targetHref: string) => (authed ? targetHref : loginRedirectHref(targetHref)),
    [authed]
  );

  React.useEffect(() => {
    setMobileOpen(false);
    setOpenGpa(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  // Close the dropdown on an outside click or Escape. The previous blur-plus-
  // timeout version swallowed clicks on its own links at unlucky moments.
  React.useEffect(() => {
    if (!openGpa) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!gpaRef.current?.contains(e.target as Node)) setOpenGpa(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenGpa(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openGpa]);

  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  // Locked areas drop out of the navbar for students. Admins keep the link,
  // since they are the ones who need to get in and fix whatever is broken.
  const [lockedKeys, setLockedKeys] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    fetch("/api/student/flags")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.locked) setLockedKeys(j.locked as Record<string, boolean>);
      })
      .catch(() => {
        // Failing open just means the link stays visible and the page itself
        // shows the notice — strictly better than hiding it on a network blip.
      });

    return () => {
      cancelled = true;
    };
  }, [authed, pathname]);

  const resourcesLocked = Boolean(lockedKeys[FlagKeys.ResourcesLocked]) && !isAdmin;

  const links = [
    { href: authed ? "/dashboard" : "/", label: authed ? "Dashboard" : "Home", icon: <LayoutDashboard className="h-4 w-4" /> },
    { href: gate("/attendance"), label: "Attendance", icon: <ClipboardCheck className="h-4 w-4" /> },
    { href: gate("/calendar"), label: "Calendar", icon: <CalendarDays className="h-4 w-4" /> },
    ...(resourcesLocked
      ? []
      : [{ href: gate("/resources"), label: "Resources", icon: <Library className="h-4 w-4" /> }]),
    { href: gate("/teams"), label: "Teams", icon: <Users className="h-4 w-4" /> },
    { href: gate("/videos"), label: "Videos", icon: <Video className="h-4 w-4" /> },
    { href: gate("/faq"), label: "FAQ", icon: <HelpCircle className="h-4 w-4" /> },
    { href: gate("/profile"), label: "Profile", icon: <UserRound className="h-4 w-4" /> },
    { href: gate("/map"), label: "Map", icon: <MapPin className="h-4 w-4" /> },
  ];

  const gpaLinks = [
    { href: gate("/gpa/estimator"), label: "GPA Estimator" },
    { href: gate("/gpa/calculator"), label: "GPA Calculator" },
  ];

  const closeDrawer = () => setMobileOpen(false);

  // Drawer must be a sibling of the blurred header, not a child. backdrop-filter
  // (and sticky) on the header create a containing block, so position:fixed
  // descendants get trapped inside the bar instead of covering the viewport.
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-foreground/10 bg-nav/95 backdrop-blur supports-[backdrop-filter]:bg-nav/80">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-4">
          {/* shrink-0 is load-bearing: without it flexbox crushes the brand to
              nothing rather than letting the nav overflow. */}
          <Link href="/" className="flex min-w-0 shrink-0 items-center gap-2">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary text-white shadow-sm">
              <GraduationCap className="h-5 w-5" />
            </span>
            <span className="truncate text-base font-extrabold tracking-tight text-foreground max-[360px]:hidden">
              CampusGuide
            </span>
          </Link>

          <nav className="ml-auto hidden min-w-0 items-center gap-0.5 xl:flex">
            {links.slice(0, 1).map((l) => (
              <BarLink key={l.href} href={l.href} label={l.label} active={isActive(l.href)} />
            ))}

            <div className="relative" ref={gpaRef}>
              <button
                type="button"
                onClick={() => setOpenGpa((v) => !v)}
                aria-expanded={openGpa}
                aria-haspopup="menu"
                className={cn(
                  "flex items-center gap-1 rounded-xl px-2.5 py-2 text-sm font-semibold whitespace-nowrap transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  isActive("/gpa")
                    ? "bg-primary text-white"
                    : "text-foreground/75 hover:bg-panel/60 hover:text-foreground"
                )}
              >
                GPA
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", openGpa && "rotate-180")} />
              </button>

              {openGpa ? (
                <div
                  role="menu"
                  className="absolute left-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-foreground/10 bg-nav shadow-xl"
                >
                  {gpaLinks.map((l) => (
                    <Link
                      key={l.href}
                      role="menuitem"
                      href={l.href}
                      onClick={() => setOpenGpa(false)}
                      className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-foreground/85 hover:bg-panel/60"
                    >
                      <GraduationCap className="h-4 w-4" />
                      {l.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>

            {links.slice(1).map((l) => (
              <BarLink key={l.href} href={l.href} label={l.label} active={isActive(l.href)} />
            ))}

            {isAdmin ? <BarLink href="/admin" label="Admin" active={isActive("/admin")} /> : null}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2 xl:ml-3">
            {!authed ? (
              <>
                <Link href="/login" className="hidden sm:block">
                  <Button variant="ghost">Sign in</Button>
                </Link>
                <Link href="/register" className="hidden sm:block">
                  <Button variant="secondary">Create account</Button>
                </Link>
              </>
            ) : (
              <Button
                variant="secondary"
                className="hidden h-10 xl:inline-flex"
                onClick={() => {
                  if (window.confirm(SIGN_OUT_CONFIRM)) void logoutEverywhere("/");
                }}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            )}

            <Button
              type="button"
              variant="secondary"
              className="h-10 w-10 rounded-2xl p-0 xl:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {mobileOpen ? (
        <div className="xl:hidden">
          <button
            type="button"
            className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm"
            aria-label="Close menu"
            onClick={closeDrawer}
          />
          {/* Explicit z-[60] so the drawer is unambiguously above the z-50
              overlay it sits next to in the DOM. */}
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="fixed inset-y-0 left-0 z-[60] flex w-[min(88vw,20rem)] flex-col border-r border-foreground/10 bg-nav pt-[env(safe-area-inset-top)] shadow-2xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-foreground/10 px-4 py-3">
              <Link href="/" onClick={closeDrawer} className="flex min-w-0 items-center gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-primary text-white shadow-sm">
                  <GraduationCap className="h-5 w-5" />
                </span>
                <span className="truncate text-base font-extrabold tracking-tight text-foreground">CampusGuide</span>
              </Link>
              <Button
                type="button"
                variant="ghost"
                className="h-10 w-10 shrink-0 rounded-2xl p-0"
                onClick={closeDrawer}
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-3">
              <DrawerLink {...links[0]} active={isActive(links[0].href)} onNavigate={closeDrawer} />

              <p className="px-3 pb-1 pt-3 text-xs font-extrabold uppercase tracking-wide text-foreground/50">GPA</p>
              {gpaLinks.map((l) => (
                <DrawerLink
                  key={l.href}
                  href={l.href}
                  icon={<GraduationCap className="h-4 w-4" />}
                  label={l.label}
                  active={isActive(l.href)}
                  onNavigate={closeDrawer}
                />
              ))}

              <p className="px-3 pb-1 pt-3 text-xs font-extrabold uppercase tracking-wide text-foreground/50">
                Study
              </p>
              {links.slice(1).map((l) => (
                <DrawerLink key={l.href} {...l} active={isActive(l.href)} onNavigate={closeDrawer} />
              ))}

              {isAdmin ? (
                <>
                  <p className="px-3 pb-1 pt-3 text-xs font-extrabold uppercase tracking-wide text-foreground/50">
                    Admin
                  </p>
                  <DrawerLink
                    href="/admin"
                    icon={<Shield className="h-4 w-4" />}
                    label="Admin dashboard"
                    active={isActive("/admin")}
                    onNavigate={closeDrawer}
                  />
                </>
              ) : null}
            </div>

            <div className="shrink-0 border-t border-foreground/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {!authed ? (
                <div className="flex flex-col gap-2">
                  <Link href="/login" onClick={closeDrawer}>
                    <Button variant="ghost" className="h-11 w-full justify-start">
                      <LogIn className="h-4 w-4" />
                      Sign in
                    </Button>
                  </Link>
                  <Link href="/register" onClick={closeDrawer}>
                    <Button variant="secondary" className="h-11 w-full justify-start">
                      <UserPlus className="h-4 w-4" />
                      Create account
                    </Button>
                  </Link>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 w-full justify-start"
                  onClick={() => {
                    if (window.confirm(SIGN_OUT_CONFIRM)) void logoutEverywhere("/");
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </Button>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
