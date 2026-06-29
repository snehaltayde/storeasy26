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
};

export default nextConfig;
