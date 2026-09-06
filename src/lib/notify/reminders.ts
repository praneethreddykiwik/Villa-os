import { read } from "../db";
import { dueReminders, markReminded } from "../appointments/engine";
import { notifyAppointment } from "./index";

export interface ReminderTickResult {
  considered: number;
  sent: number;
  failed: number;
}

/**
 * 24h-before reminders. Runs inside the follow-up tick so it fires on the
 * cron, not on a page load.
 *
 * The appointment is marked reminded *before* the send. Two overlapping ticks
 * would otherwise both see it as due and the buyer would get the reminder
 * twice; a lost send is visible in the notification log and can be chased by
 * hand, a doubled one cannot be unsent. dueReminders() already excludes
 * cancelled, completed and no-show visits.
 */
export async function sendDueReminders(withinHours = 24): Promise<ReminderTickResult> {
  const result: ReminderTickResult = { considered: 0, sent: 0, failed: 0 };
  for (const brand of read().brands) {
    for (const a of dueReminders(brand.id, withinHours)) {
      result.considered += 1;
      markReminded(a.id);
      const outcomes = await notifyAppointment({ ...a, reminderSentAt: new Date().toISOString() }, "reminder");
      if (outcomes.some((o) => o.ok)) result.sent += 1;
      else result.failed += 1;
    }
  }
  return result;
}
