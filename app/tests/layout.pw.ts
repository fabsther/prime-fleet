import { test, expect, type Page } from '@playwright/test';

// Read-only native IPC fixture: enough content to exercise each pane's scroll bounds.
test.beforeEach(async ({ page }) => {
 await page.addInitScript(() => {
  localStorage.setItem('locale', 'en');
  const items = (items: unknown[]) => ({ items, nextOffset: null });
  (window as any).__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: any) => {
   if (cmd === 'machines') return [{ id: 'a', name: 'Layout machine', url: 'https://layout.example.ts.net' }];
   if (cmd === 'auth_diagnostics') return undefined;
   if (cmd !== 'api' || args.method !== 'GET') throw Error(`Layout fixture forbids writes: ${cmd}`);
   const path = args.path.split('?')[0];
   if (path.endsWith('/machine')) return { machineId: 'studio-a', name: 'Layout machine', capabilities: ['projects', 'conversations', 'roadmaps', 'files'] };
   if (path.endsWith('/roadmap')) return { roadmap: { revision: 1, initialized: true, plans: Array.from({ length: 60 }, (_, i) => ({ id: `plan-${i}`, title: `Layout plan ${i}`, status: 'active', summary: 'Check pane scrolling.', steps: [] })) } };
   if (path.endsWith('/messages')) return items(Array.from({ length: 40 }, (_, i) => ({ id: `msg-${i}`, role: 'assistant', text: `Layout message ${i}\n\nContent stays inside the conversation pane.` })));
   if (path.endsWith('/files') || path.endsWith('/runs')) return items([]);
   if (path.endsWith('/sessions')) return items([{ id: 'session', title: 'Layout conversation', machineId: 'studio-a', projectId: 'project', updatedAt: '2026-10-13T17:00:00Z' }]);
   if (path.endsWith('/projects')) return items([{ id: 'project', name: 'Layout project', machineId: 'studio-a', exists: true }]);
   throw Error(`Unmocked layout path ${path}`);
  } };
 });
});

async function workspace(page: Page) {
 await page.goto('/');
 await expect(page.locator('.ps-row')).toHaveCount(1);
 const menu = page.locator('.fleet-mobile-menu');
 if (await menu.isVisible()) await menu.click();
 await page.locator('.ps-row').click();
 if (await menu.isVisible()) await menu.click();
 await page.locator('.ps-subrow').click();
 await expect(page.locator('.fleet-message-body')).toHaveCount(40);
 await expect(page.locator('.fleet-roadmap .ps-plan')).toHaveCount(60);
 // The drawer can still open and close without changing either pane.
 if (await menu.isVisible()) {
  await menu.click();
  await expect(page.locator('.ps-sidebar.is-open')).toBeVisible();
  await page.locator('.fleet-sidebar-backdrop.is-open').click({ position: { x: 300, y: 10 } });
  await expect(page.locator('.ps-sidebar.is-open')).toHaveCount(0);
 }
}

async function noOverflow(page: Page) {
 const bounds = await page.evaluate(() => ({
  width: innerWidth, height: innerHeight,
  documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
  bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight,
 }));
 expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.width);
 expect(bounds.bodyWidth).toBeLessThanOrEqual(bounds.width);
 expect(bounds.documentHeight).toBeLessThanOrEqual(bounds.height);
 expect(bounds.bodyHeight).toBeLessThanOrEqual(bounds.height);
}

async function assertLayout(page: Page, width: number, height: number) {
 const zones = page.locator('.fleet-zone');
 await expect(zones).toHaveCount(2);
 await expect(zones.nth(0)).toBeVisible();
 const phone = Math.min(width, height) < 600;
 // Rotation is asynchronous; wait for the viewport and read all boxes in one layout frame.
 await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
 await expect(page.locator('.fleet-app')).toHaveCSS('height', `${height}px`);
 await expect(page.locator('.ps-body')).toHaveCSS('flex-direction', !phone && height >= width ? 'column' : 'row');
 await expect(zones.nth(1))[phone ? 'toBeHidden' : 'toBeVisible']();
 const { first, second, body } = await page.evaluate(() => {
  const zones = document.querySelectorAll('.fleet-zone');
  return {
   first: zones[0].getBoundingClientRect().toJSON(),
   second: zones[1].getBoundingClientRect().toJSON(),
   body: document.querySelector('.ps-body')!.getBoundingClientRect().toJSON(),
  };
 });
 if (phone) {
  await expect(zones.nth(1)).toBeHidden();
  expect(Math.abs(first.height - body.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(first.width - body.width)).toBeLessThanOrEqual(1);
 } else {
  await expect(zones.nth(1)).toBeVisible();
  if (height >= width) {
   expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
   expect(Math.abs(second.y - (first.y + first.height))).toBeLessThanOrEqual(1);
   for (const box of [first, second]) {
    expect(box.height / body.height).toBeGreaterThan(0.49);
    expect(box.height / body.height).toBeLessThan(0.51);
    expect(Math.abs(box.width - body.width)).toBeLessThanOrEqual(1);
   }
  } else {
   expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
   expect(Math.abs(second.x - (first.x + first.width))).toBeLessThanOrEqual(1);
   expect(Math.abs(first.height - body.height)).toBeLessThanOrEqual(1);
   expect(Math.abs(second.height - body.height)).toBeLessThanOrEqual(1);
  }
  expect(second.y + second.height).toBeLessThanOrEqual(height);
 }
 for (const zone of phone ? [zones.nth(0)] : [zones.nth(0), zones.nth(1)]) {
  const selector = zone.locator('.fleet-zonebar select');
  await expect(selector).toBeVisible();
  await expect(selector).toBeEnabled();
  const box = (await selector.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  const scroll = zone.locator('.ps-pane-content');
  const state = await scroll.evaluate((node: HTMLElement) => {
   node.scrollTop = 80;
   return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, overflowY: getComputedStyle(node).overflowY };
  });
  expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth);
  expect(state.clientHeight).toBeGreaterThan(0);
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  expect(state.scrollTop).toBe(80);
  expect(state.overflowY).toBe('auto');
 }
 await noOverflow(page);
}

for (const [width, height] of [[600, 960], [720, 1152], [1200, 1920], [1800, 2880], [960, 600], [390, 844], [844, 390], [1440, 900]]) {
 test(`shortest-side layout ${width}x${height}`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height });
  await workspace(page);
  await assertLayout(page, width, height);
  // Exercise the native select itself, not only its visible box.
  const selector = page.locator('.fleet-zonebar select').first();
  await selector.selectOption('Files');
  await expect(page.locator('.fleet-zone').first().locator('.fleet-tab-content')).toBeVisible();
  await selector.selectOption('Conversation');
  await expect(page.locator('.fleet-message-body')).toHaveCount(40);
  await noOverflow(page);
  expect(errors).toEqual([]);
 });
}

test('tablet rotation keeps both zones; phone rotation stays single', async ({ page }) => {
 await page.setViewportSize({ width: 600, height: 960 });
 await workspace(page);
 for (const [width, height] of [[600, 960], [960, 600], [390, 844], [844, 390], [600, 960]]) {
  await page.setViewportSize({ width, height });
  await assertLayout(page, width, height);
 }
});
