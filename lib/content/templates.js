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
  // S38 (SF14): legal starting points — every store needs its OWN policy text
  // (defaults never cross tenants), so these scaffold the required pages.
  {
    id: "privacy",
    label: "Privacy policy",
    page: {
      slug: "privacy-policy",
      title: "Privacy policy",
      description: "What we collect, why, and your choices.",
      sections: [
        { heading: "What we collect", body: ["Order details (name, address, phone, email) to deliver your purchase.", "Analytics events, only with your consent — you can change this any time from the cookie settings."] },
        { heading: "What we never do", body: ["We don't sell your personal data.", "Payment card details are handled by our payment provider and never touch our servers."] },
        { heading: "Your rights", body: ["You can request a copy or deletion of your data — contact us and we'll action it within 30 days."] },
      ],
    },
  },
  {
    id: "terms",
    label: "Terms & refund policy",
    page: {
      slug: "terms",
      title: "Terms of service",
      description: "The terms that apply when you shop with us.",
      sections: [
        { heading: "Orders", body: ["An order is confirmed once payment succeeds (or COD is verified). We may cancel and refund orders we can't fulfil."] },
        { heading: "Refunds & returns", body: ["Unopened products can be returned within 7 days of delivery. Refunds go back to the original payment method within 5–7 working days."] },
        { heading: "Disputes", body: ["Questions first, always — contact us and we'll make it right."] },
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
