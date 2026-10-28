// Named page templates (S37 / MC09). PURE DATA — client-safe (the console
// imports this directly). A template is a starting structure for the
// content-page family; creating from one prefills the editor, the merchant
// edits/sets the slug, and the normal draft→release flow applies. The
// per-store defaults in lib/content/pages.js remain the implicit templates
// for about/contact/policies; these add structures a growing store asks for.
export const PAGE_TEMPLATES = [
  {
    id: "blank",
    label: "Blank page",
    page: { slug: "", title: "", description: "", sections: [] },
  },
  {
    id: "faq",
    label: "FAQ",
    page: {
      slug: "faq",
      title: "Frequently asked questions",
      description: "Answers to the questions we hear most.",
      sections: [
        { heading: "Orders & delivery", body: ["How long does delivery take? Standard delivery arrives in 3–5 working days.", "You'll get a tracking link as soon as your order ships."] },
        { heading: "Returns", body: ["Unopened products can be returned within 7 days of delivery.", "Start a return by replying to your order confirmation email."] },
        { heading: "Payments", body: ["We accept UPI, cards, netbanking and cash on delivery."] },
      ],
    },
  },
  {
    id: "brand-story",
    label: "Brand story",
    page: {
      slug: "our-story",
      title: "Our story",
      description: "Why we started and what we stand for.",
      sections: [
        { heading: "How it started", body: ["Tell the origin story — the moment the brand had to exist."] },
        { heading: "What we believe", body: ["The two or three principles behind every product decision."] },
        { heading: "Where we're going", body: ["What's next, and how customers shape it."] },
      ],
    },
  },
  {
    id: "how-to-use",
    label: "How to use / rituals",
    page: {
      slug: "how-to-use",
      title: "How to get the most out of it",
      description: "Usage guides and routines.",
      sections: [
        { heading: "Daily routine", body: ["Step 1 — when and how much.", "Step 2 — what to pair it with.", "Step 3 — what to expect, and when."] },
        { heading: "Pro tips", body: ["The small things regular customers swear by."] },
      ],
    },
  },
];
