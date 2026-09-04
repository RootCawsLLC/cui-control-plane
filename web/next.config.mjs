/** @type {import('next').NextConfig} */
const nextConfig = {
  // The cui-control-plane tool is never imported into the web bundle. Each run
  // happens in a separate Node ESM process (scripts/run-ccp.mjs) that imports the
  // tool's modules natively, so there is nothing here to externalize and no
  // ESM/CJS interop for the bundler to get wrong under `next start`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
