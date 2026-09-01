import Link from "next/link";
import { Lock } from "lucide-react";
import { Card } from "../ui";

/**
 * Shown instead of a page someone's role does not include.
 *
 * Deliberately written for a non-technical reader: it says what happened, why,
 * and what to do — not "403 Forbidden". It also never reveals what the page
 * would have contained.
 */
export function NoAccess({
  pathname,
  required,
  roles,
}: {
  pathname: string;
  required: string | null;
  roles: string[];
}) {
  return (
    <div className="mx-auto max-w-lg p-10">
      <Card>
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-warn-500/12 text-warn-400">
            <Lock size={17} />
          </span>
          <div>
            <h1 className="text-[16px] font-semibold text-mist-100">This page isn&rsquo;t part of your role</h1>
            <p className="mt-2 text-[12.5px] leading-relaxed text-mist-300">
              You&rsquo;re signed in as <strong>{roles.join(", ").replace(/_/g, " ") || "a user with no role"}</strong>, and
              that role doesn&rsquo;t include <code className="rounded bg-ink-800 px-1">{pathname}</code>.
            </p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-mist-400">
              This isn&rsquo;t an error — access is set per role so that customer and financial information only reaches
              the people who need it. If you need this page for your job, ask an administrator to add
              {required ? <> the <strong className="text-mist-200">{required.replace(".", " ")}</strong> permission</> : " access"} to
              your role.
            </p>
            <Link
              href="/ops"
              className="mt-4 inline-block rounded-lg bg-brand-500 px-3 py-1.5 text-[12.5px] font-medium text-[var(--a-on)] hover:bg-brand-600"
            >
              Back to my workspace
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
