import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { jest } from '@jest/globals';

// Execute the actual registered handler, not a copy of its decision tree.
// Browser integration and paginated snapshot behavior live in e2e/mouse.test.js.
const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = source.indexOf("app.post('/tabs/:tabId/mouse',");
const end = source.indexOf('\n// Viewport', start);
if (start < 0 || end < 0) throw new Error('Mouse route not found');

function createRoute({ fail = false } = {}) {
  let handler;
  let locked = false;
  const staleRefs = new Map([['e1', { role: 'button', name: 'Old target' }]]);
  const tabState = {
    refs: staleRefs,
    lastSnapshot: 'Before mouse action',
    lastStructure: { tables: ['Before mouse action'] },
    toolCalls: 0,
    page: {
      mouse: Object.fromEntries(['move', 'down', 'up', 'click'].map(action => [action, jest.fn(async () => {
        expect(locked).toBe(true);
        if (fail) throw new Error('Mouse failed');
      })])),
      waitForTimeout: jest.fn(async () => {
        expect(locked).toBe(true);
        // Simulate content cached during page settlement: invalidation must
        // happen AFTER the action, while the tab lock is still held.
        tabState.lastSnapshot = 'During mouse action';
        tabState.lastStructure = { tables: ['During mouse action'] };
      }),
    },
  };
  const session = { lastAccess: 1 };
  const events = [];
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, callback) => { handler = callback; } },
    sessions: new Map([['u1', session]]),
    normalizeUserId: String,
    findTab: (_session, tabId) => tabId === 't1' ? { tabState } : null,
    tabNotFoundResponse: res => res.status(404).json({ error: 'Tab not found' }),
    withUserLimit: async (_userId, fn) => fn(),
    withTabLock: async (_tabId, fn) => {
      locked = true;
      try { return await fn(); } finally { locked = false; }
    },
    pluginEvents: { emit: (...args) => { events.push(args); } },
    failuresTotal: { labels: () => ({ inc() {} }) },
    classifyError: () => 'error',
    log() {},
    handleRouteError: (err, _req, res) => res.status(500).json({ error: err.message }),
  });
  async function request(body = {}, tabId = 't1') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await handler({ body: { userId: 'u1', x: 160, y: 120, ...body }, params: { tabId } }, res);
    return res;
  }
  return { request, session, tabState, events };
}

describe('Mouse route post-action handling', () => {
  test.each(['click', 'move', 'down', 'up'])('%s refreshes session activity', async action => {
    const { request, session } = createRoute();
    const before = Date.now();
    expect((await request({ action })).statusCode).toBe(200);
    expect(session.lastAccess).toBeGreaterThanOrEqual(before);
  });

  test.each(['click', 'move', 'down', 'up'])('%s invalidates content after page settlement', async action => {
    const { request, tabState } = createRoute();
    expect((await request({ action })).statusCode).toBe(200);
    expect(tabState.lastSnapshot).toBeNull();
    expect(tabState.lastStructure).toBeNull();
    expect(tabState.refs.size).toBe(0);
  });

  test.each([1.5, 2.9, '2', true, false, null, [2], [], {}, 0, -1, NaN, Infinity])('rejects invalid clickCount %p without action or activity refresh', async clickCount => {
    const { request, session, tabState, events } = createRoute();
    const response = await request({ clickCount });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('clickCount must be a positive integer');
    expect(tabState.page.mouse.click).not.toHaveBeenCalled();
    expect(session.lastAccess).toBe(1);
    expect(tabState.lastSnapshot).toBe('Before mouse action');
    expect(events).toHaveLength(0);
  });

  test.each([undefined, 1, 2])('accepts numeric integer/default clickCount %p', async clickCount => {
    const { request, tabState } = createRoute();
    expect((await request({ clickCount })).statusCode).toBe(200);
    expect(tabState.page.mouse.click).toHaveBeenCalledWith(160, 120, { button: 'left', clickCount: clickCount ?? 1 });
  });

  test('failed actions do not report success or refresh activity', async () => {
    const { request, session, events } = createRoute({ fail: true });
    expect((await request()).statusCode).toBe(500);
    expect(session.lastAccess).toBe(1);
    expect(events).toHaveLength(0);
  });

  test('unknown tabs return 404', async () => {
    const { request } = createRoute();
    expect((await request({}, 'missing')).statusCode).toBe(404);
  });
});
