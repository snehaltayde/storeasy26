import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Why an upload was refused: every issue in plain words, with its place in
// the file as a muted mono line under it. Without issues, the answer's own
// sentence is the title.
//   error: the answer's sentence; issues: [{ code, path, message }] or null
export function UploadIssues({ error, issues }) {
  return (
    <Alert variant="destructive" data-themes="upload-issues">
      <CircleAlert aria-hidden="true" />
      {/* with a list, the answer's sentence (it repeats the first issue) gives way to what to do */}
      <AlertTitle>{issues?.length ? `The file wasn't uploaded. Fix ${issues.length === 1 ? "this" : `these ${issues.length} problems`} and upload it again.` : error}</AlertTitle>
      {issues?.length ? (
        <AlertDescription>
          <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1" aria-label={`${issues.length} ${issues.length === 1 ? "problem" : "problems"} in the file`}>
            {issues.map((i, n) => (
              <li key={n} data-theme-issue={i.code} className="min-w-0 border-l-2 border-destructive/40 pl-3">
                <span className="block text-foreground">{i.message}</span>
                {i.path ? (
                  <span className="block font-mono text-xs break-all text-muted-foreground">
                    <span className="sr-only">In the file at </span>
                    {i.path}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
