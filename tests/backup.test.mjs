import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'KunAI inline application script should exist');

function createApp() {
  const state = { alerts: [], readCount: 0, lastBlob: null };
  const elements = {
    task: { value: '' },
    priority: { value: '2' },
    due: { value: '' },
    stats: { innerHTML: '' },
    filter: { value: 'all' },
    list: { innerHTML: '' },
    importFile: { files: [], value: '' },
  };
  const localStorage = { kunaiTasks: '[]' };

  class MockFileReader {
    readAsText(file) {
      state.readCount += 1;
      this.result = file.content;
      this.onload?.();
    }
  }

  class MockBlob {
    constructor(parts, options) {
      state.lastBlob = { parts, options };
    }
  }

  const context = {
    ...elements,
    localStorage,
    FileReader: MockFileReader,
    Blob: MockBlob,
    URL: { createObjectURL: () => 'blob:kunai-test', revokeObjectURL() {} },
    document: {
      getElementById: (id) => elements[id],
      createElement: () => ({ click() {} }),
    },
    confirm: () => true,
    alert: (message) => state.alerts.push(message),
  };

  vm.createContext(context);
  vm.runInContext(match[1], context);
  return { context, elements, localStorage, state };
}

test('exports a versioned JSON backup', () => {
  const app = createApp();
  app.context.exportTasks();
  const payload = JSON.parse(app.state.lastBlob.parts[0]);
  assert.equal(payload.version, 1);
  assert.ok(Array.isArray(payload.tasks));
  assert.equal(app.state.lastBlob.options.type, 'application/json');
});

test('imports valid tasks and clears the file input', () => {
  const app = createApp();
  const payload = {
    version: 1,
    exportedAt: '2026-11-27T00:00:00.000Z',
    tasks: [{ id: 42, t: 'IELTS Reading', p: 3, d: '2026-11-28', done: false }],
  };
  const input = {
    files: [{ size: 256, content: JSON.stringify(payload) }],
    value: 'backup.json',
  };
  app.context.importTasks(input);
  assert.deepEqual(JSON.parse(app.localStorage.kunaiTasks), payload.tasks);
  assert.equal(input.value, '');
  assert.ok(app.state.alerts.some((message) => message.includes('muvaffaqiyatli')));
});

test('rejects oversized backups before reading them', () => {
  const app = createApp();
  const before = app.localStorage.kunaiTasks;
  const input = {
    files: [{ size: 5 * 1024 * 1024 + 1, content: '{}' }],
    value: 'large.json',
  };
  app.context.importTasks(input);
  assert.equal(app.state.readCount, 0);
  assert.equal(app.localStorage.kunaiTasks, before);
  assert.equal(input.value, '');
  assert.ok(app.state.alerts.some((message) => message.includes('5 MB')));
});

test('rejects unsupported versions and duplicate task IDs without replacing data', () => {
  const app = createApp();
  const before = app.localStorage.kunaiTasks;
  const invalidPayloads = [
    { version: 2, tasks: [] },
    { version: 1, tasks: [
      { id: 7, t: 'First', p: 2, d: '', done: false },
      { id: 7, t: 'Second', p: 1, d: '', done: true },
    ] },
  ];

  for (const payload of invalidPayloads) {
    const input = {
      files: [{ size: 512, content: JSON.stringify(payload) }],
      value: 'invalid.json',
    };
    app.context.importTasks(input);
    assert.equal(app.localStorage.kunaiTasks, before);
    assert.equal(input.value, '');
  }

  assert.equal(app.state.alerts.length, 2);
});

test('escapes imported task text before rendering it as HTML', () => {
  const app = createApp();
  const payload = {
    version: 1,
    tasks: [{ id: 99, t: '<img src=x onerror=alert(1)>', p: 2, d: '', done: false }],
  };
  app.context.importTasks({
    files: [{ size: 512, content: JSON.stringify(payload) }],
    value: 'xss.json',
  });
  assert.ok(app.elements.list.innerHTML.includes('&lt;img'));
  assert.ok(!app.elements.list.innerHTML.includes('<img'));
});
