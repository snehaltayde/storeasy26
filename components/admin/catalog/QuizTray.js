// Product-finder quizzes on the Catalog page (docs/plans/phase-2.md "Line 3"
// §1.6, decision 6): a role with storefront.write keeps the old QuizPanel (the
// page passes it in as children) in an old-screen tray, the one [data-legacy]
// region this new-UI page holds (data-legacy-tray; scripts/drills/shell
// allows it). Support gets one line of the new UI and no controls. The tray
// goes when a Phase 2 line rebuilds quizzes.
export function QuizTray({ canWrite, count, children = null }) {
  if (!canWrite) {
    return (
      <p data-quiz-summary="" className="text-sm text-muted-foreground">
        Product-finder quizzes: {count === 1 ? "1 quiz" : `${count} quizzes`}.
      </p>
    );
  }
  return (
    <section aria-label="Product-finder quizzes" data-legacy data-legacy-tray="quizzes" className="block">
      {children}
    </section>
  );
}
