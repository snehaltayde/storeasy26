"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { QUIZ_WORDS, dateWords, usedOnWords } from "./quiz-words";

// The quizzes list (Phase 2 line 10): each quiz's title (the row link to its
// editor), its address on the store, On or Off, how many questions, when it
// last changed and how many pages link to it. The search filters the loaded
// rows by title or address (a read; every quiz is on the page). "New quiz" is
// for storefront.write; support sees it disabled with the reason, and the
// rows have no write control for anyone (On/Off and Delete are in the
// editor).
export function QuizList({ quizzes, role, canWrite }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = needle ? quizzes.filter((z) => z.title.toLowerCase().includes(needle) || z.slug.includes(needle)) : quizzes;

  const newQuiz = (
    <RoleGate role={role} action="storefront.write" reason={QUIZ_WORDS.noWrite}>
      <Link href="/admin/quizzes/new" className={buttonVariants()}>
        <Plus aria-hidden /> New quiz
      </Link>
    </RoleGate>
  );

  const columns = [
    { key: "title", header: "Quiz", truncate: true, className: "w-[28%] min-w-40" },
    { key: "slug", header: "Address", cell: (z) => <span className="font-mono text-xs text-muted-foreground">/quiz/{z.slug}</span> },
    {
      key: "enabled",
      header: "State",
      cell: (z) => (
        <Badge variant={z.enabled ? "success" : "muted"} data-quiz-state={z.enabled ? "on" : "off"}>
          {z.enabled ? "On" : "Off"}
        </Badge>
      ),
    },
    { key: "questionCount", header: "Questions", align: "right", cell: (z) => <span className="block text-right font-mono tabular-nums">{z.questionCount}</span> },
    { key: "updated_at", header: "Updated", cell: (z) => <span className="text-muted-foreground">{dateWords(z.updated_at)}</span> },
    { key: "usedOn", header: "Pages", cell: (z) => <span className={z.usedOn ? "text-foreground" : "text-muted-foreground"} data-quiz-used={z.usedOn}>{usedOnWords(z.usedOn)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Quizzes" description="Product-finder quizzes: a few questions, and each answer points to catalog tags. Shoppers get the products that match best." actions={newQuiz} />

      {quizzes.length > 0 && (
        <div className="relative mb-3 max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" data-read-control aria-label="Search quizzes by title or address" placeholder="Search by title or address" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}

      <DataTable
        label="Quizzes"
        columns={columns}
        rows={rows}
        rowKey={(z) => z.slug}
        rowHref={(z) => `/admin/quizzes/${encodeURIComponent(z.slug)}`}
        footer={{ offset: 0, total: rows.length }}
        empty={
          quizzes.length ? (
            <EmptyState
              title="No quizzes match"
              description="Try another title or address."
              action={
                <button type="button" data-read-control className={buttonVariants({ variant: "outline" })} onClick={() => setQ("")}>
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState title="Make your first quiz" description="Ask shoppers a few questions and show them the products that fit. A new quiz stays off until you turn it on." action={newQuiz} />
          )
        }
      />
    </div>
  );
}
