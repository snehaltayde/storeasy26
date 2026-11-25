import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// A card's own title over skeleton rows while its read is in flight (the
// Webhooks and API access cards), so the page does not jump when it lands.
export function CardLoading({ title, rows = 3, ...rest }) {
  return (
    <Card aria-busy="true" {...rest}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Skeleton className="h-4 w-80 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
