import { defineConfig, devices } from '@playwright/test'

// Runs against the throwaway stack in docker-compose.e2e.yml. WebKit is the engine behind Safari on iPad;
// it is the closest browser we can drive from a PC, but it is not an iPad (no camera, no touch hardware,
// PC speed), so it complements the check on the real device and never replaces it.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8090',
    ...devices['iPad Pro 11 landscape'],
    locale: 'ar',
    timezoneId: 'Asia/Hebron',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'webkit-ipad', use: { browserName: 'webkit' } }],
})
