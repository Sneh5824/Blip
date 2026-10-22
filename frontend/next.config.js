// On Vercel, refuse to build without the backend URL: NEXT_PUBLIC_* values are
// baked into the bundle at build time, so a missing value would ship a broken site.
if (process.env.VERCEL && !process.env.NEXT_PUBLIC_BACKEND_URL) {
  throw new Error(
    "NEXT_PUBLIC_BACKEND_URL is not set. Add it in Vercel → Project → Settings → Environment Variables " +
    "(e.g. https://blip-backend.onrender.com) and redeploy."
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // false to avoid double-emit in dev
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Monaco editor uses a lot of workers; let @monaco-editor/react handle loading
    return config;
  },
};

module.exports = nextConfig;
