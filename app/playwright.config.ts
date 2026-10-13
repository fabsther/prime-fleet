import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'tests', testMatch:'**/*.pw.ts', workers:1, use:{browserName:'chromium',channel:'msedge',baseURL:'http://localhost:1420',reducedMotion:'reduce'}, webServer:{command:'npm run dev -- --port 1420',url:'http://localhost:1420',reuseExistingServer:true}, outputDir:'../.local/playwright' });
