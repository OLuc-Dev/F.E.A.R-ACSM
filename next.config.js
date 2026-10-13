/** @type {import('next').NextConfig} */
const desktop = process.env.NEXT_PUBLIC_FEAR_DESKTOP === "1";

const nextConfig = {
  reactStrictMode: true,
  // The Windows app ships the UI as static files served by its own backend.
  ...(desktop && { output: "export", images: { unoptimized: true } }),
};

module.exports = nextConfig;
