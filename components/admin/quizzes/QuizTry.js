"use client";

import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { MoneyCell } from "@/components/kit/money-cell";
import { scoreQuiz } from "@/lib/quiz-rules";

// "Try it" (Phase 2 line 10): answer the quiz as it is on this page, saved or
// not, On or Off. The tally is scoreQuiz (the store's own rule, run here);
// the picks come from GET /api/admin/quiz?view=try&tags=, which answers what
// the public quiz API answers for those winning tags ({ topTags, products }).
// A read for every role: nothing is saved and no shopper sees it.
//   quiz: validateQuiz's value (ids q1, q1o1 …), or null while it has problems
export function QuizTry({ quiz }) {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { topTags } = scoreQuiz(quiz, answers);
      const res = await fetch(`/api/admin/quiz?view=try&tags=${encodeURIComponent(topTags.join(","))}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That didn't work.");
      setResult({ topTags: data.topTags, products: data.products || [] });
    } catch (e) {
      setError(`We couldn't get the picks: ${e.message} Try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-quiz-try>
      <CardHeader>
        <CardTitle>Try it</CardTitle>
        <CardDescription>Answer as a shopper would. Your edits count before you save; nothing is saved here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!quiz ? (
          <p className="text-sm text-muted-foreground">Fix the problems in the quiz first, then try it here.</p>
        ) : (
          <>
            {quiz.questions.map((q, i) => (
              <div key={q.id} className="space-y-2">
                <p className="text-sm font-medium text-foreground" id={`try-${q.id}`}>
                  {i + 1}. {q.prompt}
                </p>
                <RadioGroup aria-labelledby={`try-${q.id}`} value={answers[q.id] || ""} onValueChange={(v) => (setAnswers({ ...answers, [q.id]: v }), setResult(null))}>
                  {q.options.map((o) => (
                    <div key={o.id} className="flex items-center gap-2 pointer-coarse:min-h-10">
                      <RadioGroupItem value={o.id} id={`try-${o.id}`} data-read-control />
                      <Label htmlFor={`try-${o.id}`} className="font-normal">
                        {o.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" data-read-control disabled={busy} onClick={run} data-quiz-try-run>
                {busy ? "Finding picks…" : "Show the picks"}
              </Button>
              {Object.keys(answers).length > 0 && (
                <Button type="button" variant="ghost" data-read-control onClick={() => (setAnswers({}), setResult(null))}>
                  Start again
                </Button>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-2 border-t border-border pt-3" data-quiz-try-result aria-live="polite">
            <p className="text-xs text-muted-foreground">
              {result.topTags.length ? (
                <>
                  Winning tags: <span className="font-mono text-foreground">{result.topTags.join(", ")}</span>
                </>
              ) : (
                "No answer picked a tag, so there is nothing to match."
              )}
            </p>
            {result.products.length === 0 ? (
              <p className="text-sm text-foreground">{result.topTags.length ? "No product in stock has these tags. Shoppers would see no picks." : "Pick answers with tags, then try again."}</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border" data-quiz-try-products>
                {result.products.map((p) => (
                  <li key={p.handle} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-foreground">{p.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {p.matches} {p.matches === 1 ? "tag" : "tags"}
                    </span>
                    <MoneyCell amount={p.price} currency={p.currency} className="w-24 shrink-0" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
