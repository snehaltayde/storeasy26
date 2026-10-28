import { redirect } from "next/navigation";

// S42 (MC04): the console lands on the dashboard.
export default function AdminIndex() {
  redirect("/admin/dashboard");
}
