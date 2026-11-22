/**
 * Records one demo video per flow against the demo stack (see README.md).
 * Run from the repo root:
 *   NODE_PATH=frontend/node_modules node frontend/node_modules/@playwright/test/cli.js \
 *     test -c tools/demo-recorder/playwright.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'flows.demo.ts',
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: process.env.DEMO_TMP ?? 'test-results',
  use: {
    baseURL: 'http://localhost:5175',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1366, height: 768 },
    video: { mode: 'on', size: { width: 1366, height: 768 } },
    launchOptions: { slowMo: 350 },
    actionTimeout: 20_000,
  },
});
