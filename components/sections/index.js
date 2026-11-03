import HeroSection from "./HeroSection";
import CollectionsSection from "./CollectionsSection";
import NewProductsSection from "./NewProductsSection";
import BannerSection from "./BannerSection";
import RichTextSection from "./RichTextSection";
import ImageWithTextSection from "./ImageWithTextSection";
import ProductRailSection from "./ProductRailSection";
import TextSection from "./TextSection";
import FaqListSection from "./FaqListSection";
import ProductMainSection from "./ProductMainSection";

// The renderer map (P2-SECTIONS, DOC-03; spec 8.5). One component per
// registered section kind (lib/registry/sections.js), found by kind. The home
// page (app/(storefront)/page.js and HomeSections) and content pages
// (components/ContentPage.js) render every section through SectionView.
//
// Adding a section kind takes one declaration in the registry and one entry
// here. checkSectionComponents() is the contract check: it lists a registered
// kind with no component, and a component whose kind isn't registered
// (test:sections-render runs it).
//
// Every section's root element carries data-section-id and data-section-kind
// (SectionView hands them in as `attrs`; each component spreads them on its
// root).
//
// A component may carry a static shows(section, data, ctx): false means it
// renders nothing for this data (a rail with too few products). Pages use it
// to tell "nothing rendered" apart (the DOC-03 empty-page message).
const COMPONENTS = {
  hero: HeroSection,
  collections: CollectionsSection,
  new: NewProductsSection,
  banner: BannerSection,
  rich_text: RichTextSection,
  image_with_text: ImageWithTextSection,
  product_rail: ProductRailSection,
  text: TextSection,
  faq: FaqListSection,
  product_main: ProductMainSection,
};

// Tests only: a throwaway kind's component, and taking it out again.
export function registerSectionComponent(kind, component) {
  if (Object.hasOwn(COMPONENTS, kind)) throw new Error(`section kind "${kind}" already has a component`);
  COMPONENTS[kind] = component;
  return () => {
    delete COMPONENTS[kind];
  };
}

export const sectionComponentKinds = () => Object.keys(COMPONENTS);
export const sectionComponent = (kind) => (typeof kind === "string" && Object.hasOwn(COMPONENTS, kind) ? COMPONENTS[kind] : null);

// The contract check. kinds: the registry's sectionKinds(). [] when they match.
export function checkSectionComponents(kinds) {
  const problems = [];
  for (const kind of kinds) {
    const C = sectionComponent(kind);
    if (!C) problems.push(`section kind "${kind}" is registered but has no component in components/sections/index.js`);
    else if (typeof C !== "function") problems.push(`section kind "${kind}" maps to something that isn't a component`);
  }
  for (const kind of Object.keys(COMPONENTS)) if (!kinds.includes(kind)) problems.push(`components/sections/index.js has a component for "${kind}", which isn't a registered section kind`);
  return problems;
}

export const sectionAttrs = (section) => ({ "data-section-id": section?.id ?? "", "data-section-kind": section?.kind ?? "" });

// Whether a section renders anything for this data.
export function sectionShows(section, data = {}, ctx = {}) {
  const C = sectionComponent(section?.kind);
  if (!C) return false;
  return typeof C.shows === "function" ? Boolean(C.shows(section, data, ctx)) : true;
}

// One section, through the map. Unknown kinds render nothing.
export function SectionView({ section, data = {}, ctx = {} }) {
  const C = sectionComponent(section?.kind);
  if (!C) return null;
  return <C section={section} data={data} ctx={ctx} attrs={sectionAttrs(section)} />;
}
