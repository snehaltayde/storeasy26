"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QUIZ_LIMITS } from "@/lib/quiz-rules";
import { TagPicker } from "./TagPicker";
import { READ_ONLY_FIELD } from "./quiz-words";

// A quiz's questions and their answers (Phase 2 line 10): add, move up or
// down, and delete either; each answer's tags through TagPicker. validateQuiz
// names a refusal by position ("q2", "q2o3"), so `problems` (its { at, words
// } list) puts each sentence under its own field. readOnly: every field
// disabled, no add, move or delete.
//   questions: [{ key, prompt, options: [{ key, label, tags }] }]
let seq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;
export const blankOption = () => ({ key: newKey(), label: "", tags: [] });
export const blankQuestion = () => ({ key: newKey(), prompt: "", options: [blankOption(), blankOption()] });

const move = (list, i, by) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = list.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

function Problem({ id, words }) {
  if (!words) return null;
  return (
    <p id={id} className="text-xs text-destructive" data-quiz-problem>
      {words}
    </p>
  );
}

export function QuestionList({ questions, onChange, tags, problems = [], readOnly = false }) {
  const said = (at) => problems.filter((p) => p.at === at).map((p) => p.words).join(" ") || null;
  const setQ = (i, patch) => onChange(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const setO = (i, k, patch) => setQ(i, { options: questions[i].options.map((o, j) => (j === k ? { ...o, ...patch } : o)) });

  return (
    <div className="space-y-4" data-quiz-questions>
      {questions.map((q, i) => {
        const qid = `q${i + 1}`;
        const qWords = said(qid);
        return (
          <Card key={q.key} data-quiz-question={i + 1}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle>Question {i + 1}</CardTitle>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(move(questions, i, -1))}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move question ${i + 1} down`} disabled={i === questions.length - 1} onClick={() => onChange(move(questions, i, 1))}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete question ${i + 1}`} disabled={questions.length === 1} onClick={() => onChange(questions.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={`quiz-${q.key}`}>The question</Label>
                <Input id={`quiz-${q.key}`} disabled={readOnly} className={READ_ONLY_FIELD} maxLength={300} placeholder="What are you shopping for?" value={q.prompt} aria-invalid={qWords ? true : undefined} aria-describedby={qWords ? `quiz-${q.key}-problem` : undefined} onChange={(e) => setQ(i, { prompt: e.target.value })} />
                <Problem id={`quiz-${q.key}-problem`} words={qWords} />
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-foreground">Answers</legend>
                <ol className="space-y-2">
                  {q.options.map((o, k) => {
                    const oid = `${qid}o${k + 1}`;
                    const oWords = said(oid);
                    const name = `answer ${k + 1} of question ${i + 1}`;
                    return (
                      <li key={o.key} className="space-y-2 rounded-md border border-border p-2" data-quiz-option={oid}>
                        <div className="flex items-center gap-1.5">
                          <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground tabular-nums" aria-hidden>
                            {k + 1}
                          </span>
                          <Input disabled={readOnly} className={READ_ONLY_FIELD} maxLength={120} placeholder="An answer" aria-label={`The words for ${name}`} value={o.label} aria-invalid={oWords ? true : undefined} aria-describedby={oWords ? `quiz-${o.key}-problem` : undefined} onChange={(e) => setO(i, k, { label: e.target.value })} />
                          {!readOnly && (
                            <>
                              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} up`} disabled={k === 0} onClick={() => setQ(i, { options: move(q.options, k, -1) })}>
                                <ArrowUp aria-hidden />
                              </Button>
                              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} down`} disabled={k === q.options.length - 1} onClick={() => setQ(i, { options: move(q.options, k, 1) })}>
                                <ArrowDown aria-hidden />
                              </Button>
                              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${name}`} onClick={() => setQ(i, { options: q.options.filter((_, j) => j !== k) })}>
                                <Trash2 aria-hidden />
                              </Button>
                            </>
                          )}
                        </div>
                        <div className="space-y-1.5 pl-6">
                          <Problem id={`quiz-${o.key}-problem`} words={oWords} />
                          <TagPicker value={o.tags} tags={tags} label={name} readOnly={readOnly} onChange={(next) => setO(i, k, { tags: next })} />
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {!readOnly && (
                  <Button type="button" size="sm" variant="outline" disabled={q.options.length >= QUIZ_LIMITS.options} onClick={() => setQ(i, { options: [...q.options, blankOption()] })}>
                    <Plus aria-hidden /> {q.options.length >= QUIZ_LIMITS.options ? `${QUIZ_LIMITS.options} answers at most` : "Add an answer"}
                  </Button>
                )}
              </fieldset>
            </CardContent>
          </Card>
        );
      })}
      {!readOnly && (
        <Button type="button" variant="outline" disabled={questions.length >= QUIZ_LIMITS.questions} onClick={() => onChange([...questions, blankQuestion()])} data-quiz-add-question>
          <Plus aria-hidden /> {questions.length >= QUIZ_LIMITS.questions ? `${QUIZ_LIMITS.questions} questions at most` : "Add a question"}
        </Button>
      )}
    </div>
  );
}
