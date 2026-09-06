import type { Appointment } from "../appointments/types";

/**
 * iCalendar rendering for a site visit.
 *
 * Times are written as wall-clock in Asia/Kolkata with an explicit VTIMEZONE,
 * rather than as UTC instants. A "Z" time is technically correct but renders
 * in the reader's zone — a manager travelling abroad would see the visit shift
 * off the hour the buyer was told. IST has no DST, so the block is one line.
 */
export const ICS_TIMEZONE = "Asia/Kolkata";

/** "YYYYMMDDTHHMMSS" in the given zone. */
export function icsLocal(iso: string, timeZone = ICS_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + space. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function icsFor(a: Appointment, opts: { brandName?: string; projectName?: string } = {}): string {
  const end = new Date(new Date(a.startsAt).getTime() + a.durationMinutes * 60_000).toISOString();
  const where = opts.projectName ?? opts.brandName ?? "";
  const summary = `Site visit — ${a.customerName}${where ? ` (${where})` : ""}`;
  const description = [
    `Customer: ${a.customerName}`,
    `Phone: ${a.customerPhone}`,
    a.customerEmail ? `Email: ${a.customerEmail}` : "",
    `Host: ${a.assignedTo || "Unassigned"}`,
    `Source: ${a.channel}`,
    `Status: ${a.status}`,
    a.notes ? `Notes: ${a.notes}` : "",
  ].filter(Boolean).join("\n");

  const cancelled = a.status === "cancelled";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Villa OS//Site visits//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VTIMEZONE",
    `TZID:${ICS_TIMEZONE}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0530",
    "TZOFFSETTO:+0530",
    "TZNAME:IST",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${a.id}@villa-os`,
    `DTSTAMP:${utcStamp()}`,
    // Every status move bumps the sequence, so a re-sent invite replaces the old one.
    `SEQUENCE:${a.history.length}`,
    `DTSTART;TZID=${ICS_TIMEZONE}:${icsLocal(a.startsAt)}`,
    `DTEND;TZID=${ICS_TIMEZONE}:${icsLocal(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    where ? `LOCATION:${escapeText(where)}` : "",
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(fold).join("\r\n") + "\r\n";
}
