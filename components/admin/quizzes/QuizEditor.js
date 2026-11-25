"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, ExternalLink, Info, Lock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/console/Toast";
import { sendJson, useLeaveGuard } from "@/components/admin/offers/ConfirmAction";
import { validateQuiz } from "@/lib/quiz-rules";
import { QuestionList, blankQuestion } from "./QuestionList";
import { QuizTry } from "./QuizTry";
import { DeleteQuizDialog } from "./DeleteQuizDialog";
import { QUIZ_WORDS, READ_ONLY_FIELD, pageLine } from "./quiz-words";

// Create or edit one quiz (Phase 2 line 10) on POST /api/admin/quiz: a title,
// an intro, the address (/quiz/<slug>, set at create and locked after), and
// the questions with their answers and tags. validateQuiz (the API's own
// rule) puts its refusals under each field once Save has been pressed, and
// the server's 422 does the same. Leaving with unsaved changes asks first.
// Decision 6: turning a quiz On or Off, and saving or deleting one that is
// On, is for storefront.publish; staff save quizzes that are Off, and see
// those controls disabled with the reason. Support reads the quiz with every
// field disabled and no Save, Delete or On/Off; "Try it" works for everyone.
const toForm = (q) => ({
  slug: q?.slug || "",
  title: q?.title || "",
  intro: q?.intro || "",
  // keys from positions, so the server and the browser render the same ids
  questions: q?.questions?.length
    ? q.questions.map((x, i) => ({ key: `i${i}`, prompt: x.prompt || "", options: (x.options || []).map((o, k) => ({ key: `i${i}o${k}`, label: o.label || "", tags: o.tags || [] })) }))
    : [{ ...blankQuestion(), key: "i0", options: [{ key: "i0o0", label: "", tags: [] }, { key: "i0o1", label: "", tags: [] }] }],
});
const toInput = (f) => ({ slug: f.slug.trim(), title: f.title, intro: f.intro, questions: f.questions.map((q) => ({ prompt: q.prompt, options: q.options.map((o) => ({ label: o.label, tags: o.tags })) })) });
const shape = (f) => JSON.stringify(toInput(f));
// a title as an address: "Find your fit!" → "find-your-fit"
export const slugFrom = (title) =>
  String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 61)
    .replace(/-+$/, "");

export function QuizEditor({ initial = null, pages = [], tags = [], role, canWrite, canPublish }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState(() => toForm(initial));
  const start = useRef(shape(toForm(initial)));
  const [enabled, setEnabled] = useState(Boolean(initial?.enabled));
  const [slugTouched, setSlugTouched] = useState(false);
  const [turnOn, setTurnOn] = useState(false);
  const [tried, setTried] = useState(false);
  const [serverProblems, setServerProblems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const root = useRef(null);
  // after a refused Save or On/Off, the keyboard lands on the first marked field
  const focusFirstProblem = () => requestAnimationFrame(() => root.current?.querySelector('[aria-invalid="true"]')?.focus());

  const locked = enabled && !canPublish; // staff on a quiz that is On
  const ro = !canWrite || locked;
  const input = toInput(form);
  const v = validateQuiz(input);
  const problems = serverProblems || (tried ? v.problems : []);
  const said = (at) => problems.filter((p) => p.at === at).map((p) => p.words).join(" ") || null;
  const dirty = shape(form) !== start.current || (!initial && turnOn);
  const leaving = useLeaveGuard(dirty && !ro);
  const set = (patch) => {
    setServerProblems(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  async function send(body, done) {
    setBusy(true);
    setError(null);
    try {
      const data = await sendJson("/api/admin/quiz", "POST", body);
      start.current = shape(form);
      setServerProblems(null);
      setEnabled(Boolean(data.quiz?.enabled));
      await done(data);
    } catch (e) {
      if (e.status === 422 && e.body?.problems) {
        setServerProblems(e.body.problems);
        focusFirstProblem();
      }
      setError(e.status === 422 ? "The quiz didn't save. Fix the problems marked below." : e.message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    setTried(true);
    if (!v.ok) {
      setError("The quiz didn't save. Fix the problems marked below.");
      focusFirstProblem();
      return;
    }
    const body = initial ? { quiz: input } : { quiz: input, create: true, ...(canPublish && turnOn ? { enabled: true } : {}) };
    send(body, (data) => {
      if (initial) {
        toast.success("Quiz saved.");
        router.refresh();
      } else {
        leaving.current = true;
        toast.success(data.quiz?.enabled ? "Quiz saved and turned on." : "Quiz saved. It is off until you turn it on.");
        router.replace(`/admin/quizzes/${encodeURIComponent(data.quiz.slug)}`);
      }
    });
  }

  // On/Off saves what is on the page with the new state (the server refuses
  // a quiz with problems, so nothing half-done goes live)
  function setOn(on) {
    setTried(true);
    if (!v.ok) {
      setError(`The quiz can't be turned ${on ? "on" : "off"} until the problems marked below are fixed.`);
      focusFirstProblem();
      return Promise.resolve();
    }
    return send({ quiz: input, enabled: on }, () => {
      toast.success(on ? "Quiz turned on. Shoppers can take it now." : "Quiz turned off. Shoppers no longer see it.");
      router.refresh();
    });
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      {initial && enabled && (
        <a href={`/quiz/${encodeURIComponent(initial.slug)}`} target="_blank" rel="noreferrer" data-read-control className={buttonVariants({ variant: "outline" })}>
          Open on the store <ExternalLink aria-hidden />
        </a>
      )}
      {initial && canWrite && (
        <RoleGate role={role} action="storefront.publish" reason={QUIZ_WORDS.needsPublish}>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOn(!enabled)} data-quiz-toggle={enabled ? "off" : "on"}>
            {enabled ? (dirty ? "Save and turn off" : "Turn off") : dirty ? "Save and turn on" : "Turn on"}
          </Button>
        </RoleGate>
      )}
      {initial && canWrite && (
        <RoleGate role={role} action={enabled ? "storefront.publish" : "storefront.write"} reason={QUIZ_WORDS.needsPublish}>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setAskDelete(true)} data-quiz-delete-open>
            <Trash2 aria-hidden /> Delete
          </Button>
        </RoleGate>
      )}
    </div>
  );

  const titleWords = said("title");
  const slugWords = said("slug");
  const listWords = said("questions");

  return (
    <div ref={root} data-quiz-editor={initial ? "edit" : "new"}>
      <PageHeader
        breadcrumb={[{ label: "Quizzes", href: "/admin/quizzes" }, { label: initial ? "Edit" : "New" }]}
        title={initial ? initial.title : "New quiz"}
        description={
          initial ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={enabled ? "success" : "muted"} data-quiz-state={enabled ? "on" : "off"}>
                {enabled ? "On" : "Off"}
              </Badge>
              <span>
                {enabled ? "Shoppers can take this quiz." : "Shoppers can't see this quiz while it is off."}
                {canWrite && !canPublish && !enabled ? " An owner or admin turns it on." : ""}
              </span>
            </span>
          ) : (
            "A few questions; each answer points to catalog tags. It is saved turned off unless you turn it on."
          )
        }
        actions={header}
      />

      {locked && canWrite && (
        <p className="mb-4 flex items-start gap-2 rounded-card border border-border bg-muted px-4 py-3 text-sm text-foreground" data-quiz-locked>
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          This quiz is on. {QUIZ_WORDS.needsPublish}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>The quiz</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="quiz-title">Title</Label>
                <Input
                  id="quiz-title"
                  disabled={ro}
                  className={READ_ONLY_FIELD}
                  maxLength={120}
                  placeholder="Find your perfect stack"
                  value={form.title}
                  aria-invalid={titleWords ? true : undefined}
                  aria-describedby={titleWords ? "quiz-title-problem" : undefined}
                  onChange={(e) => set({ title: e.target.value, ...(!initial && !slugTouched ? { slug: slugFrom(e.target.value) } : {}) })}
                />
                {titleWords && <p id="quiz-title-problem" className="text-xs text-destructive" data-quiz-problem>{titleWords}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quiz-slug">Address</Label>
                {initial ? (
                  <p id="quiz-slug" className="flex items-center gap-2 text-sm" data-quiz-address>
                    <Lock aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="font-mono text-foreground">/quiz/{initial.slug}</span>
                  </p>
                ) : (
                  <div className="flex items-stretch">
                    <span className="flex items-center rounded-l-md border border-r-0 border-input bg-card px-2.5 font-mono text-sm text-muted-foreground" aria-hidden>
                      /quiz/
                    </span>
                    <Input
                      id="quiz-slug"
                      disabled={ro}
                      maxLength={61}
                      className="rounded-l-none font-mono"
                      aria-describedby={slugWords ? "quiz-slug-problem quiz-slug-hint" : "quiz-slug-hint"}
                      placeholder="find-your-stack"
                      value={form.slug}
                      aria-invalid={slugWords ? true : undefined}
                      onChange={(e) => {
                        setSlugTouched(true);
                        set({ slug: e.target.value.toLowerCase() });
                      }}
                    />
                  </div>
                )}
                {slugWords && <p id="quiz-slug-problem" className="text-xs text-destructive" data-quiz-problem>{slugWords}</p>}
                <p id="quiz-slug-hint" className="text-xs text-muted-foreground">{QUIZ_WORDS.slugLocked}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quiz-intro">Intro</Label>
                <Textarea id="quiz-intro" disabled={ro} className={READ_ONLY_FIELD} rows={2} maxLength={500} placeholder="Answer three questions and we'll pick for you." value={form.intro} onChange={(e) => set({ intro: e.target.value })} />
                <p className="text-xs text-muted-foreground">Shown under the title, before the first question.</p>
              </div>
            </CardContent>
          </Card>

          {listWords && <p className="text-sm text-destructive" data-quiz-problem>{listWords}</p>}
          <QuestionList questions={form.questions} onChange={(questions) => set({ questions })} tags={tags} problems={problems} readOnly={ro} />

          {!initial && canWrite && (
            <Card size="sm">
              <CardContent className="space-y-1.5">
                {canPublish ? (
                  <>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <Checkbox checked={turnOn} onCheckedChange={(x) => setTurnOn(x === true)} aria-describedby="quiz-turn-on-hint" />
                      Turn on after saving
                    </label>
                    <p id="quiz-turn-on-hint" className="text-xs text-muted-foreground">
                      {turnOn ? "Shoppers can take it as soon as you save." : "It is saved turned off. Turn it on here when you're ready."}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{QUIZ_WORDS.staffOff}</p>
                )}
              </CardContent>
            </Card>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-quiz-error>
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:rounded-card sm:border" data-quiz-actions>
            {dirty && !ro && <span className="mr-auto text-xs text-warning-text">Unsaved changes</span>}
            <Link href="/admin/quizzes" data-read-control className={buttonVariants({ variant: "outline" })}>
              {ro ? "Back to quizzes" : "Cancel"}
            </Link>
            {canWrite && (
              <RoleGate role={role} action={enabled ? "storefront.publish" : "storefront.write"} reason={QUIZ_WORDS.needsPublish}>
                <Button type="button" disabled={busy || (initial && !dirty)} onClick={save} data-quiz-save>
                  {busy ? "Saving…" : initial ? "Save changes" : "Save quiz"}
                </Button>
              </RoleGate>
            )}
          </div>
        </div>

        <div className="space-y-4 lg:sticky lg:top-4">
          <QuizTry quiz={v.ok ? v.value : null} />
          {initial && (
            <Card size="sm" data-quiz-pages>
              <CardHeader>
                <CardTitle>Where it&rsquo;s used</CardTitle>
                <CardDescription>{pages.length ? "Pages that link to this quiz." : "No page links to this quiz yet. Add a link to /quiz/" + initial.slug + " in the editor."}</CardDescription>
              </CardHeader>
              {pages.length > 0 && (
                <CardContent>
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                    {pages.map((p) => (
                      <li key={p.document}>{pageLine(p)}</li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          )}
        </div>
      </div>

      {initial && canWrite && (
        <DeleteQuizDialog
          open={askDelete}
          onOpenChange={setAskDelete}
          quiz={{ ...initial, enabled }}
          pages={pages}
          onTurnOff={enabled && canPublish ? () => setOn(false) : null}
          onDeleted={async () => {
            leaving.current = true;
            toast.success(`Deleted “${initial.title}”.`);
            router.replace("/admin/quizzes");
          }}
        />
      )}
    </div>
  );
}
