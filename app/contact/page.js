import ContentPage from "@/components/ContentPage";
import { PAGES } from "@/lib/content/pages";

export const metadata = {
  title: PAGES.contact.title,
  description: PAGES.contact.description,
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return <ContentPage page={PAGES.contact} />;
}
