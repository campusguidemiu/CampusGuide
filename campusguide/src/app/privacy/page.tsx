import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Database, Eye, Lock, Mail, Server, Trash2 } from "lucide-react";
import { env } from "@/env";
import { whatsappLink } from "@/lib/miu";
import { SESSION_REMEMBER_DAYS } from "@/lib/session";
import { STALE_POST_DAYS } from "@/lib/teams";

export const metadata = {
  title: "Privacy Policy | CampusGuide",
};

/**
 * Written from what the app actually does, not from a template.
 *
 * Every claim here is checkable against the code: the fields on the User model,
 * what the activity log records, what the session cookie holds, and how long a
 * team post survives. If any of those change, this page is wrong and should be
 * changed with them.
 */

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <span className="text-primary">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-foreground/80">
        {children}
      </CardContent>
    </Card>
  );
}

export default function PrivacyPage() {
  const whatsapp = env.VERIFY_WHATSAPP_NUMBER;

  return (
    // Outside the (app) group, so there is no AppMain <main> supplying the
    // gutter any more - the padding that used to come from it lives here now.
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-2 px-3 py-5 sm:px-4 sm:py-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Privacy Policy</h1>
      <p className="text-sm text-foreground/70">
        What CampusGuide stores about you, why, and how to get rid of it.
      </p>

      <div className="mt-4 space-y-4">
        <Section icon={<Database className="h-5 w-5" />} title="What is stored about you">
          <p>When you register, the account holds:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Your name, university email and student ID</li>
            <li>Your phone number, used to reach you about your account</li>
            <li>Your academic year</li>
            <li>Your password, stored only as a bcrypt hash — never as text, and not readable by anyone including the admin</li>
            <li>The date you accepted the rules, because acceptance has to be recorded</li>
          </ul>
          <p>
            Anything else is something you entered yourself: your timetable, your attendance ticks,
            your midterm marks and any team posts you wrote.
          </p>
        </Section>

        <Section icon={<Eye className="h-5 w-5" />} title="What is recorded as you use it">
          <p>
            An activity log records meaningful actions — signing in, registering, an admin approving
            or banning an account, files being added or removed — together with the IP address the
            request came from. It is not a log of every page you visit.
          </p>
          <p>
            Your account also keeps the time you were last active and the address and browser you
            last used it from. That exists so the admin can spot an account being shared or broken
            into, and it is only ever the most recent value, not a history of where you have been.
          </p>
          <p>
            Failed sign-in attempts are recorded too. That is how the site notices somebody trying to
            guess a password.
          </p>
        </Section>

        <Section icon={<Lock className="h-5 w-5" />} title="Who can see it">
          <p>
            Other students see only what you deliberately publish: a team post, with the name and
            contact number you put on it. Nothing else about you is visible to them — not your email,
            your marks, your attendance or your timetable.
          </p>
          <p>
            The site administrator can see account details and the activity log, because approving
            students and dealing with abuse is not possible otherwise.
          </p>
          <p>
            Your attendance figures and marks are yours alone. They are not shared with the
            university, and they are not official records.
          </p>
        </Section>

        <Section icon={<Server className="h-5 w-5" />} title="Where it lives">
          <p>
            Account and course data are held in a MongoDB Atlas database. Files in the resources
            drive are stored on Cloudflare R2. Both are third-party hosting providers and neither is
            run by the university.
          </p>
          <p>
            Signing in sets one cookie holding a signed session token. It lasts up to{" "}
            {SESSION_REMEMBER_DAYS} days depending on whether you ticked &ldquo;remember me&rdquo;.
            There is no advertising, no analytics and no third-party tracking on this site.
          </p>
          <p>
            Videos are embedded from YouTube on its no-cookie domain, which means YouTube does not
            set tracking cookies unless you actually press play on a video.
          </p>
        </Section>

        <Section icon={<Trash2 className="h-5 w-5" />} title="How long it is kept">
          <p>
            Your account and everything attached to it stays until it is deleted. Deleting an account
            removes its personal data along with it.
          </p>
          <p>
            Team posts are not removed automatically. The admin clears out posts older than{" "}
            {STALE_POST_DAYS} days by hand, and you can delete or close your own at any time.
          </p>
        </Section>

        <Section icon={<Mail className="h-5 w-5" />} title="Asking for your data or its removal">
          <p>
            You can ask for a copy of what is stored about you, or ask for your account to be
            deleted, at any time and without giving a reason.
          </p>
          {whatsapp ? (
            <p>
              Message{" "}
              <a
                href={whatsappLink(whatsapp)}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                the administrator on WhatsApp
              </a>{" "}
              and say what you want done.
            </p>
          ) : (
            <p>Contact the site administrator and say what you want done.</p>
          )}
          <p>
            Medical reports go to the university, not to this site — send those to{" "}
            <span className="font-mono text-xs">students.medical@miuegypt.edu.eg</span>, and they are
            never stored here.
          </p>
        </Section>
      </div>

      <p className="mt-6 text-center text-xs text-foreground/50">
        CampusGuide is a student project and is not operated by Misr International University. See
        the{" "}
        <Link href="/terms" className="font-semibold text-primary underline-offset-4 hover:underline">
          rules and conditions
        </Link>{" "}
        for what using it means.
      </p>
    </div>
  );
}
