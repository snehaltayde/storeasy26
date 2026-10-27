/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root — a package-lock.json in $HOME otherwise confuses
  // Turbopack's root inference (multiple-lockfiles warning).
  turbopack: { root: import.meta.dirname },
  images: {
    // BeastLife / Shopify product imagery is served from the Shopify CDN.
    remotePatterns: [
      { protocol: "https", hostname: "cdn.shopify.com" },
    ],
  },
  // S33 (SF08 residual): outbound navigation never carries our URLs' query
  // strings (order proofs) to third parties; same-origin keeps full referrers.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }],
      },
    ];
  },
};

export default nextConfig;
