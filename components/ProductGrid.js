import ProductCard from "./ProductCard";

export default function ProductGrid({ products = [], priorityCount = 0 }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p, i) => (
        <ProductCard key={p.handle} product={p} priority={i < priorityCount} />
      ))}
    </div>
  );
}
