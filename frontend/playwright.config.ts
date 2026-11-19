/**
 * Browser tests for the frontend (#23). One seam: the browser. Every `/api/*` call is stubbed
 * per test (see e2e/support.ts) and sign-in goes through the Firebase Auth Emulator (project
 * `demo-tms`), so no backend is needed and the real Firebase project is never touched.
 *
 *   pnpm emulators                              # in another terminal (127.0.0.1:9099)
 *   pnpm --filter @tms/frontend test:e2e
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5174;
export const API_URL = 'http://api.tms.test/api';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    // Real environment variables win over frontend/.env.local, so tests never use the real project.
    env: {
      NEXT_PUBLIC_API_URL: API_URL,
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-tms.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-tms',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      NEXT_DIST_DIR: '.next-e2e',
    },
  },
});
