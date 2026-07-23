// Store content pages (Session 16) — sourced from BeastLife's live site
// (beastlife.in about/contact/policy pages, fetched 2026-07-24) and condensed
// faithfully. Legal operator: RAK Fitness Consumer Pvt. Ltd. Where the source
// page states no figure (e.g. shipping rates) we say what our store actually
// charges (lib/shipping.js) rather than inventing policy.

export const CONTACT = {
  email: "care@beastlife.in",
  phone: "+91-9599339358",
  hours: "Monday to Saturday, 10am – 10pm",
  company: "RAK Fitness Consumer Pvt. Ltd.",
  address: "5th Floor, Plot No. 112, Udyog Vihar Phase 1, Gurugram, Haryana – 122016",
  grievance: "info@beastlife.in",
};

export const PAGES = {
  about: {
    slug: "about",
    title: "About BeastLife",
    description:
      "BeastLife is a direct-to-consumer sports-nutrition brand inspired by founder Gaurav Taneja — high-performance supplements, FSSAI-tested, built for every stage of the fitness journey.",
    sections: [
      {
        heading: "Who we are",
        body: [
          "BeastLife is a direct-to-consumer fitness brand inspired by founder Gaurav Taneja (Flying Beast). We're hustlers, dreamers, and go-getters — we refuse to settle for anything less than greatness.",
          "Our mission is to empower you to be the best version of yourself, inside out — whether you're an athlete at your peak or a beginner taking the first step.",
        ],
      },
      {
        heading: "What being a beast means",
        body: [
          "We're redefining what it means to be a beast: break boundaries, do the unexpected, and unleash your inner wild. Continuous hustle, relentless improvement.",
        ],
      },
      {
        heading: "What we make",
        body: [
          "High-performance supplements for muscle building, strength, and faster recovery — whey protein, mass gainers, creatine, BCAA, peanut butter, omega supplements, wellness products, and our signature Roti 2.0 protein line.",
          "Every product is rigorously tested to FSSAI standards, with multiple quality checks before it reaches you.",
          "Train harder. Recover stronger. Go Beast Mode.",
        ],
      },
    ],
  },

  contact: {
    slug: "contact",
    title: "Contact us",
    description: "Reach BeastLife customer care — email, phone, and registered office details.",
    sections: [
      {
        heading: "Customer care",
        body: [
          `Email: ${CONTACT.email}`,
          `Phone: ${CONTACT.phone} (${CONTACT.hours})`,
        ],
      },
      {
        heading: "Registered office",
        body: [`${CONTACT.company}`, CONTACT.address],
      },
      {
        heading: "Grievances",
        body: [
          `For grievances or legal questions, contact the Grievance Officer at ${CONTACT.grievance}. Grievances are addressed within one month of receipt.`,
        ],
      },
    ],
  },

  shipping: {
    slug: "shipping",
    title: "Shipping policy",
    description: "Processing times, delivery, and shipping charges for BeastLife orders.",
    sections: [
      {
        heading: "Processing & delivery",
        body: [
          "All orders are processed within 5–7 business days. Orders are not shipped or delivered on weekends or public holidays.",
          "If we're experiencing high order volumes, shipments may be delayed by a few days — we'll keep you posted if that happens to your order.",
        ],
      },
      {
        heading: "Shipping charges",
        body: [
          "Orders of ₹999 or more (after discounts) ship free. Below that, standard shipping is ₹79.",
          "Cash on Delivery carries an additional ₹49 COD fee. All charges are shown at checkout before you pay — what you see is what you're charged.",
        ],
      },
      {
        heading: "Damaged in transit?",
        body: [
          "Please record a complete unboxing video of every delivery. If your order arrives damaged, the video is required for a return claim — see our Returns & Refund policy.",
        ],
      },
    ],
  },

  returns: {
    slug: "returns",
    title: "Returns & refund policy",
    description: "BeastLife's return eligibility, authorization process, and refund timelines.",
    sections: [
      {
        heading: "Overview",
        body: [
          "BeastLife does not accept returns or exchanges for products purchased on this website, with limited exceptions. Returns are only permitted when the conditions below are met.",
        ],
      },
      {
        heading: "Eligibility",
        body: [
          "Return requests must reach us within 3 days of your delivery date.",
          "A complete unboxing video of the product is required, along with your original Purchase Order number.",
          "Apparel and accessories must be unworn, unwashed and in good condition, with all original tags, labels, and packaging intact.",
        ],
      },
      {
        heading: "Process",
        body: [
          "Once eligibility is confirmed, you'll receive a Return Authorization Number with instructions to complete the return.",
          "Refunds are processed to the original payment method within 7–14 business days after we receive your package.",
        ],
      },
    ],
  },

  terms: {
    slug: "terms",
    title: "Terms of service",
    description: "Terms and conditions for using beastlife.in, operated by RAK Fitness Consumer Pvt. Ltd.",
    sections: [
      {
        heading: "Introduction",
        body: [
          "This website is operated by RAK Fitness Consumer Pvt. Ltd. By accessing it you accept these terms, which may be revised at any time without notice. Questions: info@beastlife.in.",
        ],
      },
      {
        heading: "Use of the site",
        body: [
          "All content is protected by copyright and intellectual-property law; it may not be copied, modified, or commercially exploited without permission. Access is limited to persons legally capable of forming binding contracts under the Indian Contract Act, 1872.",
          "Prohibited: unlawful, harassing or obscene material; unauthorized access or security probing; interfering with the site or connected networks; infringing IP; impersonation; malware; automated scraping outside standard browsers.",
        ],
      },
      {
        heading: "Liability",
        body: [
          "The website is provided \"as is\" without warranties. Total liability is limited to the amount charged for the products ordered. Manufacturer warranties are excluded.",
          "You agree to indemnify BeastLife against claims arising from your use of the site or breach of these terms.",
        ],
      },
      {
        heading: "Communications & content",
        body: [
          "We may send information about products and promotions; unsubscribe anytime (processed within seven working days). Feedback and comments you submit become the company's property and may be used without compensation.",
        ],
      },
      {
        heading: "Governing law",
        body: [
          "These terms are governed by Indian law; disputes fall under the exclusive jurisdiction of the courts of Mumbai. Grievances: the Grievance Officer at info@beastlife.in, addressed within one month.",
        ],
      },
    ],
  },

  privacy: {
    slug: "privacy",
    title: "Privacy policy",
    description: "How BeastLife collects, uses, and protects your information.",
    sections: [
      {
        heading: "Information we collect",
        body: [
          "We collect information you provide voluntarily (like your name, address, email and phone at checkout) and technical data received automatically (IP address, browser and OS details) used to analyse trends and improve the service.",
          "You retain the right to access, modify, correct, and delete your data — write to care@beastlife.in.",
        ],
      },
      {
        heading: "Cookies & analytics",
        body: [
          "We use cookies for technical administration and, only with your consent, for analytics and advertising measurement. You choose via the consent banner; declining keeps all non-essential tracking off. We do not store personally identifiable information in cookies.",
          "Where analytics data includes personal identifiers (such as email at purchase), we hash it before it leaves our systems.",
        ],
      },
      {
        heading: "Sharing",
        body: [
          "Personal information linked to your IP address is not shared without your permission or a legal requirement. Aggregate, non-identifying findings may be shared with partners.",
          "We do not use personally identifiable information to target ads, and we are not responsible for the privacy practices of external sites we link to.",
        ],
      },
      {
        heading: "Contact",
        body: [
          "Privacy concerns: care@beastlife.in — we commit to an appropriate response. Grievance Officer: info@beastlife.in.",
        ],
      },
    ],
  },
};

export const POLICY_SLUGS = ["shipping", "returns", "terms", "privacy"];
