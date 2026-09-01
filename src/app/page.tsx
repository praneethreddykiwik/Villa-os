import { redirect } from "next/navigation";

/**
 * The workspace home, not the dashboard.
 *
 * `/dashboard` needs `analytics.view`, so sending everyone there meant a front
 * desk or construction account's very first screen was a locked door. `/ops`
 * is open to anyone signed in and offers only the destinations that person's
 * role actually unlocks.
 */
export default function Home() {
  redirect("/ops");
}
