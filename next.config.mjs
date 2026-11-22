/** @type {import('next').NextConfig} */

const remotePatterns = [{ protocol: "https", hostname: "cdn.shopify.com" }];

// Allow tenant R2/S3 public origin in next/image when configured.
if (process.env.R2_PUBLIC_URL) {
  try {
    const u = new URL(process.env.R2_PUBLIC_URL);
    if (u.protocol === "https:" && u.hostname) {
      remotePatterns.push({ protocol: "https", hostname: u.hostname });
    }
  } catch {
    // ignore malformed R2_PUBLIC_URL
  }
}

const cspImgSources = ["'self'", "data:", "blob:", "https://cdn.shopify.com", "https:"].join(" ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://www.googletagmanager.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src ${cspImgSources}`,
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://www.google-analytics.com https://region1.google-analytics.com https://graph.facebook.com https://*.a1.typesense.net",
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig = {
  // Pin the workspace root — a package-lock.json in $HOME otherwise confuses
  // Turbopack's root inference (multiple-lockfiles warning).
  turbopack: { root: import.meta.dirname },
  images: {
    remotePatterns,
  },
  // S33 + Phase 1.2: strict security headers across storefronts & console.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
        ],
      },
    ];
  },
};

export default nextConfig;
