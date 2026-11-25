import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listExperiments, analyzeExperiment } from "@/lib/experiments";
import { tfetch } from "@/lib/console-request";
import { ExperimentDetail } from "@/components/admin/experiments/AnalysisPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Experiment · Admin", robots: { index: false } };

// One experiment (Phase 2 line 9): its plan and its analysis (the only
// reader of results, lib/experiments.js analyzeExperiment). Every role reads
// it (storefront.read); the screen gets the caller's role and gates Start and
// Resume on storefront.publish, the rest on storefront.write. An unknown slug
// is the not-found page.
export default async function AdminExperimentPage({ params }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const { slug } = await params;
  const found = await tfetch(async () => {
    const experiment = (await listExperiments()).find((e) => e.slug === slug);
    if (!experiment) return null;
    let analysis = null;
    try {
      analysis = await analyzeExperiment(slug);
    } catch {
      analysis = null; // the screen says the results couldn't be read
    }
    return { experiment, analysis };
  });
  if (!found) notFound();
  return <ExperimentDetail experiment={found.experiment} analysis={found.analysis} role={actor.role} />;
}
