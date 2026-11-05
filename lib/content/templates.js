// Named page templates (S37 / MC09). PURE DATA — client-safe (the console
// imports this directly). A template is a starting structure for the
// content-page family; creating from one prefills the editor, the merchant
// edits/sets the slug, and the normal draft→release flow applies. The
// per-store defaults in lib/content/pages.js remain the implicit templates
// for about/contact/policies; these add structures a growing store asks for.
//
// P6-POLICY-START (PUB-12, GEN-06 partly; owner answer OQ-P6-2): the returns
// text is bound to the store's real returns window. The engine's window is
// the tenant setting returns_window_days (lib/returns.js returnsWindowDays(),
// default 14), counted from the ORDER date (returnEligibility reads
// order.created_at), never from delivery. No number is written here:
//   returnsSentence(days)   1..365 -> "… within <days> days of your order."
//                           ("1 day" for 1); 0 or below -> no returns; a
//                           fraction rounded down (P6-FIX1, below); anything
//                           else -> the sentence with no number
//   templatesFor({ returnsWindowDays, plain })  the template list, fresh
//                           objects on each call, with both returns sentences
//                           (the terms template's "Refunds & returns" and the
//                           FAQ's "What's the return policy?") built by
//                           returnsSentence. plain: true leaves out the
//                           refund-timing day count, which no setting backs,
//                           so the returns starter the system writes for the
//                           founder makes no unset promise
//                           (scripts/support/banned-copy.js)
//   PAGE_TEMPLATES          templatesFor(): the legacy PageEditor's list. It
//                           can't read the setting, so it says the sentence
//                           with no number (binding it is GEN-06)
//   POLICY_STARTERS         the template ids the policy starters use
//                           (lib/first-run/policy-start.js)
// Not bound yet (GEN-06 known limits): the refund-timing sentence, the FAQ's
// delivery sentence and its payment-methods sentence.

// P6-FIX1: the sentence says what the engine does with the number it is
// given. lib/returns.js's returnEligibility refuses a return once the order is
// more than `windowDays` days old (fractions count: 10.5 is ten and a half
// days), so:
//   a number 0 or below    no order can ever be returned -> NO_RETURNS
//   a fraction above 1     rounded DOWN to whole days (10.5 -> "10 days"): the
//                          page never promises more time than the engine gives
//   a fraction below 1     whole hours, rounded down ("within 12 hours");
//                          under one hour -> NO_RETURNS (the page never
//                          promises a return the engine might refuse)
//   1..365 days            that many days ("1 day" for 1)
//   over 365, not a finite number, not a number at all -> the sentence with
//                          no number (the legacy PageEditor's list passes none)
// returnsWindowDays() itself turns 0, a missing value and anything not a
// number into its default, so a store whose setting is 0 gets that default here.
export const NO_RETURNS = "We don't accept returns on orders.";
const NO_NUMBER = "Unopened products can be returned within our return window, counted from the day you order.";
const within = (n, unit) => `Unopened products can be returned within ${n} ${n === 1 ? unit : `${unit}s`} of your order.`;

export function returnsSentence(days) {
  if (typeof days !== "number" || !Number.isFinite(days)) return NO_NUMBER;
  if (days <= 0) return NO_RETURNS;
  if (days < 1) {
    const hours = Math.floor(days * 24);
    return hours >= 1 ? within(hours, "hour") : NO_RETURNS;
  }
  const whole = Math.floor(days);
  return whole <= 365 ? within(whole, "day") : NO_NUMBER;
}

// Whether returnsSentence(days) offers returns at all (the FAQ's "Start a
// return" line is left out when it doesn't).
export const acceptsReturns = (days) => returnsSentence(days) !== NO_RETURNS;

// The policy starters: kind -> template id. The returns starter is the terms
// template (slug "terms"; its "Refunds & returns" section carries the window),
// which lib/documents/policy-pages.js isReturnsSlug matches.
export const POLICY_STARTERS = Object.freeze({ privacy: "privacy", returns: "terms" });

// The refund-timing sentence no setting backs yet (GEN-06). Without plain it
// stays as it was, so the legacy PageEditor's prefill is unchanged apart from
// the returns window. The FAQ's delivery and payment-method sentences are not
// bound either (GEN-06); no starter uses the FAQ template.
const REFUND_TIMING = "Refunds go back to the original payment method within 5–7 working days.";
const REFUND_PLAIN = "Refunds go back to the original payment method.";

export function templatesFor({ returnsWindowDays, plain = false } = {}) {
  const returns = returnsSentence(returnsWindowDays);
  const refunds = plain ? REFUND_PLAIN : REFUND_TIMING;
  return [
    {
      id: "blank",
      label: "Blank page",
      page: { slug: "", title: "", description: "", sections: [] },
    },
    {
      id: "faq",
      label: "FAQ",
      // S39 (SF16): built on the faq section kind — accordions with deep links.
      page: {
        slug: "faq",
        title: "Frequently asked questions",
        description: "Answers to the questions we hear most.",
        sections: [
          {
            kind: "faq",
            heading: "Orders & delivery",
            items: [
              { q: "How long does delivery take?", a: "<p>Standard delivery arrives in 3–5 working days. You'll get a tracking link as soon as your order ships.</p>" },
              { q: "Can I change my address after ordering?", a: "<p>If the order hasn't shipped yet — contact us with your order id and the new address.</p>" },
            ],
          },
          {
            kind: "faq",
            heading: "Returns & payments",
            items: [
              { q: "What's the return policy?", a: acceptsReturns(returnsWindowDays) ? `<p>${returns} Start a return by replying to your order confirmation email.</p>` : `<p>${returns}</p>` },
              { q: "Which payment methods do you accept?", a: "<p>UPI, cards, netbanking and cash on delivery.</p>" },
            ],
          },
        ],
      },
    },
    {
      id: "campaign",
      label: "Campaign landing",
      // S39 (SF17): a campaign page scaffold — set the visibility window and
      // it serves at /campaigns/<slug>; links keep the visitor's UTM params.
      page: {
        slug: "launch",
        title: "The launch drop",
        family: "campaign",
        description: "Limited-time launch offers.",
        sections: [
          { kind: "rich", heading: "For a limited time", html: '<p>Our launch line is live — while stock lasts.</p><p><a href="/collections">Shop the drop →</a></p>' },
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
          { heading: "Refunds & returns", body: [`${returns} ${refunds}`] },
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
}

export const PAGE_TEMPLATES = templatesFor();
