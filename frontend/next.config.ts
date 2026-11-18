import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages are included.
  outputFileTracingRoot: path.join(__dirname, '..'),
};

export default nextConfig;
