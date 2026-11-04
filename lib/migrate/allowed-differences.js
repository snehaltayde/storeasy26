// P4-EQUIV (MIG-02): the differences the rendered comparison sets aside when a
// store moves to the new editor. The spec names test-migrate-documents for
// this list: P4-CUTOVER's suite (scripts/test-migrate-documents.js) imports
// ALLOWED_DIFFERENCES from here and asserts the same list; this item's suite
// (scripts/test-migrate-render.js) proves every entry has a reason and that
// its fixture fails without it.
//
// Anything not listed here stops the move. Things that differ between two
// visits to the SAME store (scripts, build ids, hashed assets, nonces,
// generated ids, date-times, streaming order) are not here: normalize() in
// lib/migrate/render-compare.js removes them for every page.
//
// Each entry:
//   id        a short name (reports, tests)
//   reason    why no shopper is hurt by it, in plain words
//   apply(tree, ctx)
//             rewrites one side's normalized tree so the allowed variation
//             disappears; called for both sides. ctx: { route, side,
//             before: { experiments, heroExperiments },
//             after: { experiments, heroExperiments } }
//   fixture   { route, before, after, heroExperiments? }: two small pages
//             that differ ONLY in this way. Compared without the entry they
//             differ; with it they are the same (test-migrate-render checks
//             both). heroExperiments, when present, is passed to compare()
//             as its option of that name.
//
// The data check's own rules (lib/migrate/check.js, sameForShoppers) are a
// separate list over getter answers, not pages; CUTOVER may move them here.
import { attrOf, eachElement } from "./render-compare.js";

// A home or page section's id as the old store wrote it (its position, i-<n>)
// or as documents hold it (sec_<…>, sec_l<n> for a moved one).
const SECTION_ID = /^(i-\d+|sec_[A-Za-z0-9_-]+)$/;

const page = (body, script = "") => `<!DOCTYPE html><html lang="en"><head><title>Shop</title></head><body><main>${body}</main>${script}</body></html>`;
const flight = (slug, unit) => `<script>self.__next_f.push([1,"2a:[\\"$\\",\\"$L176\\",null,{\\"slug\\":\\"${slug}\\",\\"unit\\":\\"${unit}\\"}]\\n"])</script>`;
const hero = (title) => `<section data-sec="hero" data-section-id="sec_hero" data-section-kind="hero" class="bg-hero"><h1>${title}</h1><a href="/collections">Shop now</a></section>`;

export const ALLOWED_DIFFERENCES = Object.freeze([
  Object.freeze({
    id: "section-ids",
    reason:
      "The move gives every home and page section a lasting id where the old store used its position (i-2 becomes sec_l2). The id only reaches the page in the data-section-id and data-sec attributes, which shoppers never see and no stylesheet uses. What kind of section it is (data-section-kind), its content and its order are still compared.",
    apply(tree) {
      return eachElement(tree, (n) => {
        n.attrs = n.attrs.filter(([k]) => k !== "data-section-id").map(([k, v]) => (k === "data-sec" && SECTION_ID.test(v) ? [k, "<section id>"] : [k, v]));
      });
    },
    fixture: Object.freeze({
      route: "/",
      before: page(`<section data-sec="i-2" data-section-id="i-2" data-section-kind="rich_text" class="py-sf-section"><h2>Our story</h2><p>Made in small batches.</p></section>`),
      after: page(`<section data-sec="sec_l2" data-section-id="sec_l2" data-section-kind="rich_text" class="py-sf-section"><h2>Our story</h2><p>Made in small batches.</p></section>`),
    }),
  }),
  Object.freeze({
    id: "hero-test-variant",
    reason:
      "While a hero test runs, a visitor with no unit cookie (the comparison sends none) is given a new random unit on every visit, so the home page shows one hero or the other at random, before and after the move alike. Only when BOTH captures show the same running hero test (named by its slug, as the store lists it) is the hero's inside set aside; the hero's content is still compared as data by the in-process check (resolvedHomePage, P4-MAPPER), and a test that started or stopped is still a difference.",
    apply(tree, ctx) {
      // P4-FIX4: only the hero test counts, by its slug (the store's running
      // experiment with target hero, read by --make-routes and kept in each
      // capture's index.json). Another test pinging on the home page never
      // sets the hero aside, and with no hero slug known nothing is.
      const heroA = new Set(ctx?.before?.heroExperiments ?? []);
      const heroB = new Set(ctx?.after?.heroExperiments ?? []);
      const a = (ctx?.before?.experiments ?? []).filter((s) => heroA.has(s) && heroB.has(s));
      const b = (ctx?.after?.experiments ?? []).filter((s) => heroA.has(s) && heroB.has(s));
      if (!a.length || a.join() !== b.join()) return tree;
      return eachElement(tree, (n) => {
        if (attrOf(n, "data-sec") === "hero") n.children = [{ text: `(a running test picks this hero at random: ${a.join(", ")})` }];
      });
    },
    fixture: Object.freeze({
      route: "/",
      // the slug of the store's running hero test (compare's heroExperiments)
      heroExperiments: Object.freeze(["hero-promise"]),
      before: page(hero("<span>Winter repair</span>, started."), flight("hero-promise", "c6153b39-ec10-4417-ad55-1bb5f92ab4c1")),
      after: page(hero("Visibly brighter in 14 days"), flight("hero-promise", "0b1c2d3e-4f50-4617-8899-aabbccddeeff")),
    }),
  }),
]);

export const allowedDifferenceIds = () => ALLOWED_DIFFERENCES.map((d) => d.id);
