import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Response.json() omits the charset; clients that fall back to
        // latin1/cp1252 then render UTF-8 text as mojibake.
        // This rule OVERRIDES route-set content-type headers (verified
        // locally), so non-JSON routes must be excluded: /api/og/* and
        // /api/share/* serve image/png, and generate-missing-graphs
        // streams text/event-stream.
        source:
          "/api/:path((?!og/|share/|admin/films/generate-missing-graphs).*)",
        headers: [
          {
            key: "content-type",
            value: "application/json; charset=utf-8",
          },
        ],
      },
    ];
  },
  turbopack: {
    root: ".",
  },
  serverExternalPackages: [
    "sharp",
    "@resvg/resvg-js",
    "@expo-google-fonts/dm-sans",
    "@expo-google-fonts/playfair-display",
    "@expo-google-fonts/libre-baskerville",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "*.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
