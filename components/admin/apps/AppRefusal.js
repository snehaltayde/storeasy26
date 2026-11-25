import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

// A refusal in the route's own plain words, announced to screen readers.
// Nothing typed is cleared when it shows.
export function AppRefusal({ children }) {
  if (!children) return null;
  return (
    <Alert variant="destructive" role="alert" data-apps="refusal">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
