import ContentPage from "@/components/ContentPage";
import { PAGES } from "@/lib/content/pages";

export const metadata = {
  title: PAGES.about.title,
  description: PAGES.about.description,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return <ContentPage page={PAGES.about} />;
}
