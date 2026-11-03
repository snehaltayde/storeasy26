// The product page's protected commerce module (registry kind "product_main":
// photos, price, options and the buy button). Shopify owns its data; a layout
// only places it. The product route still renders its own page (it doesn't
// render layouts through this map yet), so this places whatever the route
// hands in as ctx.productMain, and nothing when it hands in nothing.
function ProductMainSection({ section, ctx = {}, attrs = {} }) {
  if (!ProductMainSection.shows(section, {}, ctx)) return null;
  return <div {...attrs}>{ctx.productMain}</div>;
}
ProductMainSection.shows = (section, data, ctx = {}) => ctx.productMain != null;

export default ProductMainSection;
