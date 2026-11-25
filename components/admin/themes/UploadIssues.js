import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Why an upload was refused: every issue in plain words with its place.
//   error: the answer's sentence; issues: [{ code, path, message }] or null
export function UploadIssues({ error, issues }) {
  return (
    <Alert variant="destructive" data-themes="upload-issues">
      <AlertTitle>{error}</AlertTitle>
      {issues?.length ? (
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {issues.map((i, n) => (
              <li key={n} data-theme-issue={i.code}>
                {i.message}
                {i.path ? <span className="text-muted-foreground"> (at <code className="break-all">{i.path}</code>)</span> : null}
              </li>
            ))}
          </ul>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
