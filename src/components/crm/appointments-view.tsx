"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle, CalendarPlus, Check, Clock, Loader2, MessageCircle, Phone, RefreshCw, UserRound, X,
} from "lucide-react";
import clsx from "clsx";
import type { Appointment, AppointmentChannel, AppointmentStatus, Slot } from "@/lib/appointments/types";
import { HOLDS_SLOT } from "@/lib/appointments/types";
import { relativeDay } from "@/lib/crm/format";
import { Badge, Card, Empty, SectionTitle } from "../ui";

const STATUS_TONE: Record<AppointmentStatus, "neutral" | "good" | "warn" | "bad" | "brand"> = {
  requested: "warn",
  confirmed: "good",
  rescheduled: "brand",
  completed: "neutral",
  no_show: "bad",
  cancelled: "neutral",
};

const CHANNELS: AppointmentChannel[] = ["whatsapp", "phone", "walk_in", "website", "instagram", "staff"];

function label(status: AppointmentStatus): string {
  return status.replace("_", " ");
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function dayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
}

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  appointment?: Appointment;
  /** False when a double submit matched a booking that already existed. */
  created?: boolean;
  slots?: Slot[];
  alternatives?: Slot[];
}

type Outcome =
  | { ok: true; body: ApiEnvelope }
  | { ok: false; error: string; alternatives?: Slot[] };

/**
 * One place where a response is judged, because judging it in six places is how
 * this codebase ended up rendering a 403 as a completed booking.
 *
 * Three separate failures are collapsed into one shape: the request never left
 * (offline, aborted), the body is not JSON at all (an HTML error page from a
 * proxy — `res.json()` throws and an unguarded caller would treat the throw as a
 * crash or, worse, catch it and carry on), and the request arrived but was
 * refused. Both `res.ok` and `body.ok` are checked: the status alone misses a
 * 200 carrying `ok:false`, and `body.ok` alone misses a 403 whose body has no
 * `ok` field at all — `undefined` is falsy, but only by luck, not by contract.
 */
async function request(url: string, init?: RequestInit): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: "Could not reach the server — nothing was changed." };
  }

  let body: ApiEnvelope;
  try {
    body = (await res.json()) as ApiEnvelope;
  } catch {
    return { ok: false, error: `The server returned an unreadable response (HTTP ${res.status}).` };
  }

  if (!res.ok || body.ok !== true) {
    return {
      ok: false,
      error: body.error ?? `Request failed (HTTP ${res.status}).`,
      alternatives: body.alternatives,
    };
  }
  return { ok: true, body };
}

/**
 * The site-visit desk.
 *
 * Everything an operator does to a visit happens here: book one against a real
 * slot, move it, or close it out with an outcome. Times are never free-typed —
 * they are picked from `/api/appointments/slots`, so the screen cannot offer a
 * Sunday evening the team is not open for, and the server re-checks anyway.
 */
export function AppointmentsView({
  appointments,
  brandId,
  brandName,
  leads,
  staff,
}: {
  appointments: Appointment[];
  brandId: string;
  brandName: string;
  leads: Array<{ id: string; name: string; phone: string }>;
  staff: string[];
}) {
  const [rows, setRows] = useState(appointments);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Slots are fetched for one target at a time — "new" for the booking form, or
  // an appointment id when moving that booking. Keyed rather than global so a
  // stale list from another target can never be offered.
  const [slotTarget, setSlotTarget] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [alternatives, setAlternatives] = useState<Slot[]>([]);

  const [form, setForm] = useState({
    leadId: "",
    customerName: "",
    customerPhone: "",
    channel: "phone" as AppointmentChannel,
    assignedTo: "",
    notes: "",
  });

  // A reason is mandatory server-side for no-show and cancelled, so the button
  // opens a prompt instead of firing a request that is going to be rejected.
  const [pending, setPending] = useState<{ id: string; to: AppointmentStatus } | null>(null);
  const [reason, setReason] = useState("");

  const buckets = useMemo(() => {
    const now = Date.now();
    const dayEnd = new Date();
    dayEnd.setHours(23, 59, 59, 999);
    const endOfToday = dayEnd.getTime();

    const sorted = [...rows].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const live = sorted.filter((a) => HOLDS_SLOT.includes(a.status));

    const overdue = live.filter((a) => new Date(a.startsAt).getTime() < now);
    const today = live.filter((a) => {
      const t = new Date(a.startsAt).getTime();
      return t >= now && t <= endOfToday;
    });
    const upcoming = live.filter((a) => new Date(a.startsAt).getTime() > endOfToday);

    const byDay = new Map<string, Appointment[]>();
    for (const a of upcoming) {
      const key = new Date(a.startsAt).toDateString();
      byDay.set(key, [...(byDay.get(key) ?? []), a]);
    }

    const closed = sorted
      .filter((a) => !HOLDS_SLOT.includes(a.status))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
      .slice(0, 12);

    return { overdue, today, upcoming: [...byDay.entries()], closed, live };
  }, [rows]);

  /** Replace-or-append: a duplicate submit returns the booking that already exists. */
  function upsert(a: Appointment) {
    setRows((r) => (r.some((x) => x.id === a.id) ? r.map((x) => (x.id === a.id ? a : x)) : [...r, a]));
  }

  async function loadSlots(target: string) {
    setSlotTarget(target);
    setSlots([]);
    setAlternatives([]);
    setLoadingSlots(true);
    setError(null);
    const params = new URLSearchParams({ brandId, days: "14" });
    // A reschedule must see the slot it currently occupies as free, or moving a
    // booking an hour later and back would report its own place as taken.
    if (target !== "new") params.set("excludeAppointmentId", target);
    const out = await request(`/api/appointments/slots?${params.toString()}`);
    setLoadingSlots(false);
    if (!out.ok) {
      setError(out.error);
      setSlotTarget(null);
      return;
    }
    setSlots(out.body.slots ?? []);
    if (!out.body.slots?.length) {
      setNotice("No open slots in the next 14 days — check the opening hours before promising a time.");
    }
  }

  async function book(startsAt: string) {
    if (!form.customerName.trim() || !form.customerPhone.trim()) {
      setError("A name and a reachable phone number are required — the confirmation goes there.");
      return;
    }
    setBusy("book");
    setError(null);
    setNotice(null);
    const out = await request("/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brandId,
        startsAt,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        channel: form.channel,
        leadId: form.leadId || undefined,
        assignedTo: form.assignedTo || undefined,
        notes: form.notes.trim() || undefined,
      }),
    });
    setBusy(null);

    if (!out.ok) {
      setError(out.error);
      // The server hands back what is still free when the chosen time has gone.
      setAlternatives(out.alternatives ?? []);
      return;
    }
    const appointment = out.body.appointment;
    if (!appointment) {
      setError("The booking was accepted but came back empty — reload before booking again.");
      return;
    }
    upsert(appointment);
    // The server dedupes a double submit and says so. Reporting that as a fresh
    // booking would have the operator believe two visits exist where one does.
    setNotice(
      out.body.created === false
        ? `${appointment.customerName} was already booked for ${dayHeading(appointment.startsAt)}, ${timeOf(appointment.startsAt)} — nothing was duplicated.`
        : `Booked ${appointment.customerName} for ${dayHeading(appointment.startsAt)}, ${timeOf(appointment.startsAt)}.`,
    );
    setAlternatives([]);
    setSlotTarget(null);
    setForm({ leadId: "", customerName: "", customerPhone: "", channel: "phone", assignedTo: "", notes: "" });
  }

  async function move(id: string, newStartsAt: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
    const out = await request("/api/appointments", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, to: "rescheduled", newStartsAt }),
    });
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      setAlternatives(out.alternatives ?? []);
      return;
    }
    if (out.body.appointment) upsert(out.body.appointment);
    setNotice(`Moved to ${dayHeading(newStartsAt)}, ${timeOf(newStartsAt)}. Tell the buyer.`);
    setSlotTarget(null);
    setAlternatives([]);
  }

  async function close(id: string, to: AppointmentStatus, why?: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
    const out = await request("/api/appointments", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, to, reason: why?.trim() || undefined }),
    });
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    if (out.body.appointment) upsert(out.body.appointment);
    setPending(null);
    setReason("");
    setNotice(`Marked ${label(to)}.`);
  }

  const slotDays = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = new Date(s.startsAt).toDateString();
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [slots]);

  function pickSlot(startsAt: string) {
    if (slotTarget === "new") void book(startsAt);
    else if (slotTarget) void move(slotTarget, startsAt);
  }

  /**
   * `slotPicker()` and `row()` are called, not mounted as child components.
   *
   * A component declared inside another component is a new function identity on
   * every render, which React treats as a different type and remounts — so the
   * reason field below, controlled by state that lives up here, would lose focus
   * after every single keystroke. Calling them inlines the elements into this
   * component's own tree, where state and focus survive a re-render.
   */
  function slotPicker() {
    if (loadingSlots) {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-ink-700 p-3 text-[12px] text-mist-400">
          <Loader2 size={13} className="animate-spin" /> Loading open slots…
        </div>
      );
    }
    if (!slotDays.length) {
      return (
        <p className="rounded-xl border border-ink-700 p-3 text-[12px] text-mist-400">
          No open slots in the next 14 days.
        </p>
      );
    }
    return (
      <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-ink-700 p-3">
        {slotDays.map(([day, list]) => (
          <div key={day}>
            <div className="mb-1.5 flex items-center gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">{dayHeading(day)}</h4>
              <span className="text-[10.5px] text-mist-500">{relativeDay(new Date(day).toISOString())}</span>
              <span className="h-px flex-1 bg-ink-700" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {list.map((s) => (
                <button
                  key={s.startsAt}
                  onClick={() => pickSlot(s.startsAt)}
                  disabled={busy !== null}
                  className="tnum rounded-lg border border-ink-700 px-2 py-1 text-[11.5px] text-mist-200 hover:border-brand-500 hover:text-mist-100 disabled:opacity-40"
                  title={`${s.remaining} place(s) left`}
                >
                  {timeOf(s.startsAt)}
                  <span className="ml-1 text-[10px] text-mist-500">·{s.remaining}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function row(a: Appointment, tone?: "overdue") {
    const closedOut = !HOLDS_SLOT.includes(a.status);
    const canComplete = a.status === "confirmed" || a.status === "rescheduled";
    const canMove = a.status !== "completed" && a.status !== "cancelled";

    return (
      <div
        key={a.id}
        className={clsx(
          "rounded-xl border p-3",
          closedOut ? "border-ink-700 opacity-55" : tone === "overdue" ? "border-bad-500/35 bg-bad-500/[0.05]" : "border-ink-700",
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="tnum flex shrink-0 items-center gap-1 text-[12px] text-mist-200">
            <Clock size={11} className="text-mist-400" /> {timeOf(a.startsAt)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-mist-100">{a.customerName}</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-mist-400">
              <span className="tnum flex items-center gap-1">
                {a.channel === "whatsapp" ? <MessageCircle size={9} /> : <Phone size={9} />} {a.customerPhone}
              </span>
              <span>· {a.channel.replace("_", " ")}</span>
              <span className="flex items-center gap-1">
                <UserRound size={9} /> {a.assignedTo || "Unassigned"}
              </span>
              <span>· {a.durationMinutes}m</span>
            </div>
            {a.notes && <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">{a.notes}</p>}
            {a.cancelledReason && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">Reason: {a.cancelledReason}</p>
            )}
          </div>

          <Badge tone={STATUS_TONE[a.status]}>{label(a.status)}</Badge>
          {busy === a.id && <Loader2 size={13} className="animate-spin text-mist-400" />}

          {!closedOut && (
            <div className="flex flex-wrap items-center gap-1.5">
              {a.status === "requested" && (
                <button
                  onClick={() => void close(a.id, "confirmed")}
                  disabled={busy !== null}
                  className="rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:border-good-500/50 hover:text-good-400 disabled:opacity-40"
                >
                  Confirm
                </button>
              )}
              {canComplete && (
                <button
                  onClick={() => void close(a.id, "completed")}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:border-good-500/50 hover:text-good-400 disabled:opacity-40"
                >
                  <Check size={10} /> Completed
                </button>
              )}
              {canComplete && (
                <button
                  onClick={() => { setPending({ id: a.id, to: "no_show" }); setReason(""); }}
                  disabled={busy !== null}
                  className="rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:border-bad-500/50 hover:text-bad-400 disabled:opacity-40"
                >
                  No-show
                </button>
              )}
              {canMove && (
                <button
                  onClick={() => void loadSlots(a.id)}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:border-ink-600 hover:text-mist-100 disabled:opacity-40"
                >
                  <RefreshCw size={10} /> Reschedule
                </button>
              )}
              <button
                onClick={() => { setPending({ id: a.id, to: "cancelled" }); setReason(""); }}
                disabled={busy !== null}
                className="rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-400 hover:border-bad-500/50 hover:text-bad-400 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {pending?.id === a.id && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 p-2">
            <span className="text-[11px] text-mist-300">Why {label(pending.to)}?</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              placeholder={pending.to === "no_show" ? "Did not arrive, phone unanswered…" : "Buyer postponed indefinitely…"}
              className="min-w-[200px] flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-[11.5px] outline-none focus:border-brand-500"
            />
            <button
              onClick={() => void close(a.id, pending.to, reason)}
              disabled={busy !== null || !reason.trim()}
              className="rounded-lg bg-brand-500 px-2.5 py-1 text-[11px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => { setPending(null); setReason(""); }}
              className="rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-mist-400 hover:text-mist-100"
            >
              Cancel
            </button>
          </div>
        )}

        {slotTarget === a.id && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-mist-400">
              <span>Pick a new time — the current one stays free for this booking.</span>
              <button onClick={() => setSlotTarget(null)} className="ml-auto text-mist-400 hover:text-mist-100">
                <X size={12} />
              </button>
            </div>
            {slotPicker()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {(error || notice) && (
        <div className="space-y-2">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-bad-500/35 bg-bad-500/[0.06] p-3 text-[12px] text-bad-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div>
                <p>{error}</p>
                {alternatives.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-mist-400">Still open:</span>
                    {alternatives.map((s) => (
                      <button
                        key={s.startsAt}
                        onClick={() => pickSlot(s.startsAt)}
                        disabled={busy !== null}
                        className="tnum rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-mist-200 hover:border-brand-500 hover:text-mist-100 disabled:opacity-40"
                      >
                        {dayHeading(s.startsAt)}, {timeOf(s.startsAt)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => { setError(null); setAlternatives([]); }} className="ml-auto shrink-0 hover:text-mist-100">
                <X size={12} />
              </button>
            </div>
          )}
          {notice && (
            <div className="flex items-center gap-2 rounded-xl border border-good-500/30 bg-good-500/[0.06] p-3 text-[12px] text-good-400">
              <Check size={13} /> {notice}
              <button onClick={() => setNotice(null)} className="ml-auto hover:text-mist-100">
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      <Card>
        <SectionTitle
          title="Book a site visit"
          hint="Times come from the configured opening hours and remaining capacity — not from a free-text field."
          action={
            <button
              onClick={() => (slotTarget === "new" ? setSlotTarget(null) : void loadSlots("new"))}
              className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
            >
              <CalendarPlus size={13} /> {slotTarget === "new" ? "Close" : "New visit"}
            </button>
          }
        />

        {slotTarget === "new" ? (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-2">
              <label className="text-[11px] text-mist-400">
                Existing lead
                <select
                  value={form.leadId}
                  onChange={(e) => {
                    const lead = leads.find((l) => l.id === e.target.value);
                    // Prefilling from the lead keeps one buyer as one record; a
                    // retyped phone number becomes a second person to the engine.
                    setForm((f) => ({
                      ...f,
                      leadId: e.target.value,
                      customerName: lead?.name ?? f.customerName,
                      customerPhone: lead?.phone ?? f.customerPhone,
                    }));
                  }}
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
                >
                  <option value="">Not linked to a lead</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} · {l.phone}</option>
                  ))}
                </select>
              </label>

              <label className="text-[11px] text-mist-400">
                Assigned to
                <select
                  value={form.assignedTo}
                  onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
                >
                  <option value="">Unassigned — the desk will fill it in</option>
                  {staff.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>

              <label className="text-[11px] text-mist-400">
                Name
                <input
                  value={form.customerName}
                  onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
                  placeholder="Who is coming"
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] outline-none focus:border-brand-500"
                />
              </label>

              <label className="text-[11px] text-mist-400">
                Phone
                <input
                  value={form.customerPhone}
                  onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))}
                  placeholder="+91…"
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] outline-none focus:border-brand-500"
                />
              </label>

              <label className="text-[11px] text-mist-400">
                Came in via
                <select
                  value={form.channel}
                  onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as AppointmentChannel }))}
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
                >
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>{c.replace("_", " ")}</option>
                  ))}
                </select>
              </label>

              <label className="text-[11px] text-mist-400">
                Notes
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Bringing family, wants the corner plot…"
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] outline-none focus:border-brand-500"
                />
              </label>
            </div>

            <p className="text-[11px] text-mist-400">Pick a time to book — the visit is created the moment you choose.</p>
            {slotPicker()}
          </div>
        ) : (
          <p className="text-[12px] text-mist-400">
            {buckets.live.length
              ? `${buckets.live.length} visit(s) currently holding a slot for ${brandName}.`
              : `Nothing booked for ${brandName} yet.`}
          </p>
        )}
      </Card>

      {buckets.overdue.length > 0 && (
        <Card>
          <SectionTitle
            title="Needs an outcome"
            hint="These start times have passed and the visit is still open. Until it is closed the slot stays held and the lead's stage is wrong."
          />
          <div className="space-y-1.5">
            {buckets.overdue.map((a) => row(a, "overdue"))}
          </div>
        </Card>
      )}

      <Card>
        <SectionTitle title="Today" hint="Still to happen today, in order." />
        {buckets.today.length ? (
          <div className="space-y-1.5">
            {buckets.today.map((a) => row(a))}
          </div>
        ) : (
          <p className="py-6 text-center text-[12px] text-mist-400">Nothing left on today&rsquo;s plan.</p>
        )}
      </Card>

      <Card>
        <SectionTitle title="Upcoming" hint="Grouped by day, so the week reads as a plan." />
        {buckets.upcoming.length ? (
          <div className="space-y-4">
            {buckets.upcoming.map(([day, list]) => (
              <div key={day}>
                <div className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">{dayHeading(day)}</h4>
                  <span className="text-[10.5px] text-mist-500">{relativeDay(new Date(day).toISOString())}</span>
                  <span className="h-px flex-1 bg-ink-700" />
                </div>
                <div className="space-y-1.5">
                  {list.map((a) => row(a))}
                </div>
              </div>
            ))}
          </div>
        ) : !buckets.live.length ? (
          <Empty
            title="No site visits booked"
            hint={`Nothing is on the calendar for ${brandName}. Book one above — the times offered are the ones the team is actually open for.`}
          />
        ) : (
          <p className="py-6 text-center text-[12px] text-mist-400">Nothing after today.</p>
        )}
      </Card>

      {buckets.closed.length > 0 && (
        <Card>
          <SectionTitle
            title="Recently closed"
            hint="Completed, no-show and cancelled visits, newest first. Kept visible so an outcome you just recorded does not simply vanish."
          />
          <div className="space-y-1.5">
            {buckets.closed.map((a) => row(a))}
          </div>
        </Card>
      )}
    </div>
  );
}
