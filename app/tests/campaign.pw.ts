import { test, expect, type Page } from '@playwright/test';

// Fully mocked native IPC. No live Studio traffic or writes.
async function fixture(page: Page, postacceptRace = false) {
  await page.addInitScript((postacceptRace) => {
    localStorage.setItem('locale', 'en');
    const w = window as any;
    w.__calls = []; w.__conflict = false; w.__owner = null; w.__runs = [];
    const callbacks = new Map<number, any>(), listeners = new Map<string, number[]>(); let next = 1;
    const items = (items: unknown[]) => ({ items, nextOffset: null });
    const machine = { id: 'a', name: 'BAGUETTE', url: 'https://mock.example.ts.net' };
    const plan = { id: 'plan', title: 'Campaign safety', summary: '@campaign', steps: [
      { id: 'one', text: 'New guest', note: '@machine: BAGUETTE\n@gui', done: false },
      { id: 'two', text: 'Own bot', note: '@machine: BAGUETTE', done: false },
    ] };
    const old = { id: 'old-guest', sessionId: 'old-session', machineId: 'studio-a', projectId: 'project', status: 'running', startedAt: '' };
    w.__emit = (event: string, payload: any) => (listeners.get(event) ?? []).forEach(id => callbacks.get(id)?.({ payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: any) => { const id = next++; callbacks.set(id, fn); return id; },
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, ...args });
        if (cmd === 'machines') return [machine];
        if (cmd === 'auth_diagnostics') return undefined;
        if (cmd === 'plugin:event|listen') { listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]); return args.handler; }
        if (cmd === 'plugin:event|unlisten' || cmd === 'stop_stream') return;
        if (cmd === 'stream') return `stream-${next++}`;
        if (cmd !== 'api') throw Error(`Unmocked native command ${cmd}`);
        const path = args.path.split('?')[0];
        if (args.method === 'POST') {
          if (path.endsWith('/roadmap/work')) {
            const id = args.body.targets[0].stepId;
            const run = { id, sessionId: `s-${id}`, machineId: 'studio-a', projectId: 'project', status: 'running', startedAt: '' };
            w.__runs.push(run); if (postacceptRace) w.__conflict = true;
            return { accepted: true, queued: false, run, sessionId: run.sessionId, machineId: 'studio-a', projectId: 'project', requestId: args.body.requestId };
          }
          if (path.endsWith('/computer-use')) {
            if (w.__owner) throw Error('Fixture forbids takeover');
            w.__owner = { projectId: 'project', runId: args.body.runId };
            return { machineId: 'studio-a', revision: 2, supported: true, enabled: true, owner: w.__owner, ownerHidden: false, busy: false, cleanupPending: false, cleanupFailed: false };
          }
          throw Error(`Fixture forbids unrelated POST ${path}`);
        }
        if (path.endsWith('/machine')) return { machineId: 'studio-a', name: machine.name, capabilities: ['projects', 'conversations', 'runs', 'roadmaps', 'computer-use'] };
        if (path.endsWith('/computer-use')) return { machineId: 'studio-a', revision: 2, supported: true, enabled: !!w.__owner, owner: w.__owner, ownerHidden: false, busy: false, cleanupPending: false, cleanupFailed: false };
        if (path.endsWith('/roadmap')) return { machineId: 'studio-a', projectId: 'project', roadmap: { revision: 3, initialized: true, plans: [plan] } };
        if (path.endsWith('/runs')) return items([...w.__runs, ...(w.__conflict ? [old] : [])]);
        if (path.startsWith('/api/v1/runs/')) return structuredClone(w.__runs.find((r: any) => r.id === path.split('/').at(-1)));
        if (path.endsWith('/projects')) return items([{ id: 'project', name: 'Game', machineId: 'studio-a', syncId: null }]);
        if (path.endsWith('/sessions')) return items(w.__runs.map((r: any) => ({ id: r.sessionId, title: r.id, projectId: 'project', machineId: 'studio-a' })));
        if (path.endsWith('/messages') || path.endsWith('/files')) return items([]);
        throw Error(`Unmocked GET ${path}`);
      },
    };
  }, postacceptRace);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'BAGUETTE' })).toBeVisible();
  await page.locator('.ps-row').filter({ hasText: 'Game' }).click();
  await page.locator('.ps-plan-title').filter({ hasText: 'Campaign safety' }).click();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Launch campaign', exact: true }).click();
}

test('accepted raced guest keeps its identity, displays conflict, blocks next player and withholds CU', async ({ page }) => {
  await fixture(page, true);
  const players = page.locator('.fleet-campaign-player');
  await expect(players).toHaveCount(2);
  await expect(players.first().getByRole('alert')).toContainText('old-guest');
  await expect(players.first().getByRole('button', { name: 'Open conversation' })).toBeEnabled();
  await expect(players.first()).toContainText('Accepted run ID: one');
  await expect(players.first()).toContainText('Session ID: s-one');
  await expect(players.first()).toContainText('Request ID: cmp_');
  await expect(players.nth(1).getByRole('button', { name: 'Open conversation' })).toBeDisabled();
  await expect(players.nth(1).locator('.ps-status')).toHaveText('Blocked');
  const writes = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'api' && c.method === 'POST'));
  expect(writes).toHaveLength(1); expect(writes[0].path).toMatch(/roadmap\/work$/);
  await page.getByRole('button', { name: 'Launch campaign', exact: true }).click();
  await expect(page.locator('.fleet-roadmap-message')).toContainText('Stop or resolve the current campaign');
  await expect(players.first()).toContainText('Accepted run ID: one');
  await expect(page.getByRole('button', { name: 'Stop all', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'api' && c.method === 'POST').length)).toBe(1);
});

test('six-minute resumed guest and global other-session owner become visible without SSE or any write', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  const players = page.locator('.fleet-campaign-player');
  await expect(players.first().getByRole('status')).toHaveText('Project activity and Computer Use ownership verified.');
  await expect(players.nth(1).getByRole('status')).toHaveText('No other active runs in this project at the last check.');
  const initialWrites = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'api' && c.method === 'POST').length);
  await page.evaluate(() => {
    const w = window as any; w.__calls = []; w.__conflict = true;
    w.__owner = { projectId: 'project', sessionId: 'old-session' };
  });
  await page.clock.fastForward(6 * 60000);
  await expect(players.first().getByRole('alert')).toContainText('old-guest');
  await expect(players.nth(1).getByRole('alert')).toContainText('old-guest');
  await expect(players.first()).toContainText('Ownership unverified');
  await expect(players.first().locator('.ps-status')).toHaveText('Degraded');
  const checks = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'api'));
  expect(initialWrites).toBe(3); // Two own players plus one exact-run CU grant.
  expect(checks.every((c: any) => c.method === 'GET')).toBe(true);
  expect(checks.filter((c: any) => c.path.startsWith('/api/v1/runs?'))).toHaveLength(1); // shared by both players
  expect(checks.filter((c: any) => c.path.startsWith('/api/v1/computer-use'))).toHaveLength(1);
  expect(checks.some((c: any) => c.path.includes('computer-use?'))).toBe(false);
  await page.evaluate(() => (window as any).__emit('fleet-stream', { machineId: 'a', path: '/api/v1/runs/one/events', event: { status: 'running' } }));
  await expect(players.first().locator('.ps-status')).toHaveText('Degraded'); // SSE must not erase the warning.
});
