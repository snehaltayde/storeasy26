// Canonical commerce, catalog, cart, offers, bundles, and checkout contracts.

export interface ProductImage {
  url: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ProductVariant {
  id: string;
  productId: string;
  title: string;
  sku: string | null;
  price: number;
  compareAtPrice?: number | null;
  currency: string;
  available: boolean;
  inventoryQuantity?: number | null;
  selectedOptions?: Array<{ name: string; value: string }>;
  imageUrl?: string | null;
}

export interface EffectiveProduct {
  id: string;
  handle: string;
  /** Effective shopper-facing title (published override ?? Shopify title) */
  title: string;
  description: string | null;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  badge: string | null;
  tags: string[];
  priceMin: number;
  priceMax: number;
  compareAtPrice?: number | null;
  currency: string;
  available: boolean;
  featuredImage: string | null;
  featuredImageAlt: string | null;
  images?: ProductImage[];
  variants?: ProductVariant[];
}

export interface CartLine {
  variantId: string;
  productId: string;
  variantNumericId: string | null;
  handle: string;
  title: string;
  /** Server-only fields — stripped by shopperCart() before sending to browser */
  catalog_title?: string | null;
  sku?: string | null;
  variantTitle: string;
  priceAtAdd: number | null;
  image: string | null;
  price: number;
  currency: string;
  quantity: number;
  lineTotal: number;
  available: boolean;
  discount: number;
}

export interface CartChangeNotice {
  variantId: string;
  title: string;
  kind: "unavailable" | "price_changed";
  from?: number;
  to?: number;
}

export interface ShippingQuote {
  label: string;
  total: number;
  free: boolean;
  remainingForFree: number;
  codFee?: number;
  eta?: string | null;
}

export interface Cart {
  id: string | null;
  coupon: string | null;
  items: CartLine[];
  changes?: CartChangeNotice[];
  subtotal: number;
  count: number;
  currency: string;
  appliedOffers: Array<{
    id: string;
    title: string;
    type: string;
    saving: number;
  }>;
  gifts: Array<{
    variantId: string;
    productId?: string;
    handle?: string;
    title: string;
    image?: string | null;
    value?: number;
    catalog_title?: string | null;
    sku?: string | null;
  }>;
  discountTotal: number;
  total: number;
  shipping: ShippingQuote | null;
  shippingRatesSet?: boolean;
  grandTotal: number;
  couponStatus: {
    code: string;
    valid: boolean;
    reason?: string;
  } | null;
}

export interface BatchCartItemInput {
  variantId: string;
  quantity?: number;
}

export interface CheckoutCapability {
  available: boolean;
  mode: "direct" | "disabled" | "shopify";
  cod: boolean;
  razorpay: boolean;
  reason?: string | null;
}

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "cod_pending"
  | "syncing_shopify"
  | "synced"
  | "sync_failed"
  | "cancelled"
  | "refunded";

export interface OrderSummary {
  id: string;
  email: string;
  status: OrderStatus;
  fulfillmentStatus: string | null;
  paymentMethod: "cod" | "razorpay" | "prepaid" | string;
  total: number;
  currency: string;
  createdAt: string;
}
