import { fileURLToPath } from "node:url";

const nextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    // Constrain sandbox navigation as well as subresources. The frame itself has a stricter CSP.
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'" }] }];
  },
};
export default nextConfig;
