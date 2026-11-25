import Link from "next/link";
import Image from "@/components/StoreImage";

export default function CollectionCard({ collection }) {
  const { handle, title, image, image_alt, product_count } = collection;
  return (
    <Link
      href={`/collections/${handle}`}
      data-part="collection-card"
      className="group relative block aspect-[4/3] overflow-hidden rounded-sf-card bg-sf-media"
    >
      {image ? (
        <Image
          src={image}
          alt={image_alt || title}
          fill
          sizes="(min-width:1024px) 33vw, (min-width:640px) 50vw, 100vw"
          className="object-cover opacity-85 transition duration-500 group-hover:scale-105 group-hover:opacity-100"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-sf-media-from to-sf-media-to" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-sf-overlay/75 via-sf-overlay/10 to-transparent" />
      <div className="absolute bottom-0 left-0 p-4">
        <h3 className="text-lg font-bold text-sf-on-overlay">{title}</h3>
        {product_count != null && (
          <p className="text-xs text-sf-on-overlay/70">{product_count} products</p>
        )}
      </div>
    </Link>
  );
}
