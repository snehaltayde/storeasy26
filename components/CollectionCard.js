import Link from "next/link";
import Image from "next/image";

export default function CollectionCard({ collection }) {
  const { handle, title, image, image_alt, product_count } = collection;
  return (
    <Link
      href={`/collections/${handle}`}
      className="group relative block aspect-[4/3] overflow-hidden rounded-2xl bg-zinc-900"
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
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-800 to-zinc-950" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
      <div className="absolute bottom-0 left-0 p-4">
        <h3 className="text-lg font-bold text-white">{title}</h3>
        {product_count != null && (
          <p className="text-xs text-white/70">{product_count} products</p>
        )}
      </div>
    </Link>
  );
}
