import FaqSection from "@/components/FaqSection";
import { settingsOf } from "./parts";

// Questions and answers (registry kind "faq"), through the existing keyboard
// accordion (components/FaqSection.js). On content pages it is that component
// as before; on the home page it sits in the home page's spacing.
function FaqListSection({ section, ctx = {}, attrs = {} }) {
  const s = settingsOf(section);
  const items = Array.isArray(s.items) ? s.items : [];
  if (ctx.surface === "page") return <FaqSection {...attrs} heading={s.title} items={items} />;
  return (
    <div data-sec={ctx.secKey} {...attrs} className="max-w-3xl py-sf-section">
      <FaqSection heading={s.title} items={items} />
    </div>
  );
}

export default FaqListSection;
