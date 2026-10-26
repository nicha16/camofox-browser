import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Mouse endpoint', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('clicks viewport coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      const result = await client.mouse(tabId, { x: 160, y: 120 });
      expect(result).toMatchObject({ ok: true, action: 'click', x: 160, y: 120 });

      const snapshot = await client.waitForSnapshotContains(tabId, 'Mouse clicked!');
      expect(snapshot.snapshot).toContain('Mouse clicked!');
    } finally {
      await client.cleanup();
    }
  });

  test('sends move/down/up actions at viewport coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      await expect(client.mouse(tabId, { action: 'move', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'move', x: 160, y: 120 });
      let snapshot = await client.waitForSnapshotContains(tabId, 'Mouse moved!');
      expect(snapshot.snapshot).toContain('Mouse moved!');

      await expect(client.mouse(tabId, { action: 'down', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'down', x: 160, y: 120 });
      snapshot = await client.waitForSnapshotContains(tabId, 'Mouse down!');
      expect(snapshot.snapshot).toContain('Mouse down!');

      await expect(client.mouse(tabId, { action: 'up', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'up', x: 160, y: 120 });
    } finally {
      await client.cleanup();
    }
  });

  test('rejects invalid coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      await expect(client.mouse(tabId, { x: 'not-a-number', y: 120 }))
        .rejects.toThrow('numeric x and y required');
    } finally {
      await client.cleanup();
    }
  });

  test.each([
    ['click', 'Mouse clicked!'],
    ['move', 'Mouse moved!'],
    ['down', 'Mouse down!'],
    // Releasing a held left button also dispatches click in a real browser.
    ['up', 'Mouse clicked!'],
  ])('%s invalidates paginated snapshots and rendered structure', async (action, expected) => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);
      if (action === 'up') await client.mouse(tabId, { action: 'down', x: 160, y: 120 });
      const before = await client.getSnapshot(tabId);
      expect(before.snapshot).not.toContain(expected);
      expect(JSON.stringify(before.structure)).not.toContain(expected);

      await client.mouse(tabId, { action, x: 160, y: 120 });
      // A nonzero offset hits the cached-chunk path unless the mouse route
      // correctly invalidates it. Do not fetch offset=0 first: that masks bugs.
      const after = await client.getSnapshot(tabId, { offset: 1 });
      expect(after.snapshot).toContain(expected);
      expect(JSON.stringify(after.structure)).toContain(expected);
    } finally {
      await client.cleanup();
    }
  });

  test('strictly rejects non-integer clickCount over HTTP', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);
      for (const clickCount of [1.5, '2', true, null, [2], {}, 0, -1]) {
        await expect(client.mouse(tabId, { x: 160, y: 120, clickCount }))
          .rejects.toMatchObject({ status: 400, message: 'clickCount must be a positive integer' });
      }
      await expect(client.mouse(tabId, { x: 160, y: 120, clickCount: 2 }))
        .resolves.toMatchObject({ ok: true });
    } finally {
      await client.cleanup();
    }
  });

  test('refs and selectors still work after a coordinate action', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);
      await client.mouse(tabId, { action: 'move', x: 160, y: 120 });
      const snapshot = await client.getSnapshot(tabId);
      const ref = snapshot.snapshot.match(/button "Mouse Target" \[(e\d+)\]/)?.[1];
      expect(ref).toBeDefined();
      await expect(client.click(tabId, { ref })).resolves.toMatchObject({ ok: true });
      await expect(client.click(tabId, { selector: '#target' })).resolves.toMatchObject({ ok: true });
      expect((await client.getSnapshot(tabId)).snapshot).toContain('Mouse clicked!');
    } finally {
      await client.cleanup();
    }
  });
});
