import { BarChart3, MessageSquare, ShieldCheck, Workflow } from "lucide-react";
import { GlentreeMark } from "./mark";

/**
 * The left half of the sign-in screen on wide viewports.
 *
 * It states what the product is before asking anyone to prove who they are,
 * which is the difference between a login box and a front door. Below 1024px it
 * is not rendered at all — on a phone the form is the only thing worth the
 * space, and shipping a hidden column would still cost the markup.
 */
const PILLARS = [
  {
    icon: MessageSquare,
    title: "Every conversation in one place",
    body: "WhatsApp, Instagram and Facebook land in the same inbox, with the reply history attached to the customer.",
  },
  {
    icon: Workflow,
    title: "Work that moves itself along",
    body: "Enquiry to sale to loan to handover, with the follow-ups scheduled rather than remembered.",
  },
  {
    icon: BarChart3,
    title: "Spend you can actually read",
    body: "Meta and Google campaigns side by side, with the recommendation written in plain words.",
  },
];

export function BrandPanel() {
  return (
    <div className="relative hidden flex-col gap-12 py-12 pl-10 lg:flex xl:pl-4">
      <div className="flex items-center gap-3.5">
        <GlentreeMark size={46} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[17px] font-semibold tracking-tight text-mist-100">Glentree</span>
            <span className="rounded-full bg-brand-500/15 border border-brand-500/30 px-2 py-0.5 text-[9.5px] font-semibold tracking-wide text-brand-300">
              VILLA-OS
            </span>
          </div>
          <div className="text-[11.5px] text-mist-500">Social · Ads · CRM · Operations · Voice AI</div>
        </div>
      </div>

      <div className="max-w-[460px]">
        <h2 className="text-[32px] font-bold leading-[1.18] tracking-tight gradient-heading">
          One workspace for the whole business.
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-mist-400">
          Marketing, sales, loans, social publishing and AI voice agents stop living in separate tabs and start
          sharing one real-time operational core.
        </p>

        <ul className="mt-9 space-y-6">
          {PILLARS.map((p) => {
            const Icon = p.icon;
            return (
              <li key={p.title} className="flex gap-3.5 group">
                <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl liquid-glass-pill text-brand-300 shadow-md group-hover:scale-110 transition-transform duration-200">
                  <Icon size={17} />
                </span>
                <div>
                  <div className="text-[13.5px] font-semibold text-mist-200">{p.title}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-mist-400">{p.body}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="flex items-center gap-2 text-[11.5px] text-mist-500">
        <ShieldCheck size={13} />
        Passwords are held by Supabase Auth. This application never sees one.
      </p>
    </div>
  );
}
