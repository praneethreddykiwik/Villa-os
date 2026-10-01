import { redirect } from "next/navigation";

/** "Villa profile" is now the general tab of Settings. */
export default function VillaProfileRedirect() {
  redirect("/settings");
}
