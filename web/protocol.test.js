import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResult,
  DeviceStateStore,
  describeError,
  describeOperation,
  describeResult,
  describeUiState,
  LED_COLORS,
  LineParser,
  SerialClient,
  SerialCommandWriter,
  STATUS_STALE_AFTER_MS,
  buildCommand,
  buttonOrderChoices,
  buttonOrderLabel,
  normalizeStatus,
  rgbAt,
} from './protocol.js';

const status = {
  protocol: 2,
  selectedPc: 2,
  pcs: [
    { registered: true, connected: true, name: null, intervalUs: 11250 },
    { registered: false, connected: false, name: null },
    { registered: true, connected: false, name: 'Office' },
  ],
  inputs: [
    { id: 'k1', slot: 1, registered: true, connected: true, name: null, intervalUs: 7500 },
    { id: 'k2', slot: null, registered: false, connected: false, name: null },
    { id: 'm1', slot: 3, registered: true, connected: false, name: null },
    { id: 'm2', slot: null, registered: false, connected: false, name: null },
  ],
  legacyInputs: [{ slot: 4, registered: true, connected: false }],
  ui: {
    state: 'normal',
    target: null,
    operation: null,
    remainingMs: 0,
    result: '',
    confirmationId: 0,
  },
};

function makeFakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setInterval(callback, interval) {
      const id = ++nextId;
      timers.set(id, { callback, interval, next: now + interval });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    tick(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.next <= target)
          .sort((left, right) => left.next - right.next)[0];
        if (!due) break;
        now = due.next;
        due.callback();
        due.next += due.interval;
      }
      now = target;
    },
  };
}

function makeOpenPort() {
  let controller;
  let writeFailure = false;
  const writes = [];
  const writer = {
    async write(bytes) {
      if (writeFailure) throw new Error('poll write failed');
      writes.push(new TextDecoder().decode(bytes));
    },
    releaseLock() {},
  };
  const port = {
    readable: new ReadableStream({ start(nextController) { controller = nextController; } }),
    writable: { getWriter: () => writer },
    async open() {},
    async close() {},
  };
  return {
    port,
    writes,
    enqueue(value) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    },
    setWriteFailure(value) {
      writeFailure = value;
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('LineParser handles split JSON, multiple lines, logs, and invalid JSON', () => {
  const parser = new LineParser();
  assert.deepEqual(parser.push('log boot\n{"protocol":2,"selectedPc":1'), [
    { kind: 'log', line: 'log boot' },
  ]);
  assert.deepEqual(parser.push('}\r\n{"ok":true}\n{broken}\n'), [
    { kind: 'json', value: { protocol: 2, selectedPc: 1 } },
    { kind: 'json', value: { ok: true } },
    { kind: 'invalid-json', line: '{broken}' },
  ]);
  assert.deepEqual(parser.push('plain log\n'), [{ kind: 'log', line: 'plain log' }]);
  assert.deepEqual(parser.flush(), []);
});

test('normalizeStatus validates protocol v2 while preserving null names', () => {
  const normalized = normalizeStatus(status);
  assert.equal(normalized.protocol, 2);
  assert.equal(normalized.pcs[0].name, null);
  assert.equal(normalized.inputs[1].slot, null);
  assert.equal(normalized.legacyInputs[0].slot, 4);
  assert.equal(normalized.candidateGeneration, 0);
  assert.deepEqual(normalized.candidates, []);
  assert.equal(normalized.ui.resultRemainingMs, 0);
  assert.equal(normalizeStatus({ ...status, ui: { ...status.ui, result: 'success' } }).ui.resultRemainingMs, 600);
  assert.equal(normalizeStatus({ ...status, ui: { ...status.ui, result: 'success', resultRemainingMs: 173 } }).ui.resultRemainingMs, 173);
  assert.throws(() => normalizeStatus({ ...status, ui: { ...status.ui, result: 'success', resultRemainingMs: -1 } }), /resultRemainingMs/i);
  assert.throws(() => normalizeStatus({ ...status, protocol: 1 }), /protocol/i);
  assert.throws(() => normalizeStatus({ ...status, pcs: [] }), /pcs/i);
  assert.throws(() => normalizeStatus({
    ...status,
    ui: { ...status.ui, state: 'confirm', target: 'pc1', operation: 'forget', confirmationId: 0 },
  }), /confirmationId/i);
});

test('normalizeStatus preserves optional fast interval status for PCs and mouse inputs', () => {
  const pcFast = {
    stage: 0,
    targetUnits: 6,
    attempts: 2,
    pending: true,
    requestRc: 0,
    lastUpdate: { status: 0, intervalUs: 15000 },
  };
  const inputFast = {
    stage: 1,
    targetUnits: 12,
    attempts: 3,
    pending: false,
    requestRc: -8,
    lastUpdate: { status: -8, intervalUs: 15000 },
    peerRequests: {
      connUpdateReq: { count: 2, minUnits: 12, maxUnits: 24 },
      l2capUpdateReq: { count: 1, minUnits: 12, maxUnits: 18 },
    },
  };
  const normalized = normalizeStatus({
    ...status,
    pcs: status.pcs.map((entry, index) => index === 0 ? { ...entry, fast: pcFast } : entry),
    inputs: status.inputs.map((entry, index) => index === 2 ? { ...entry, fast: inputFast } : entry),
  });

  assert.deepEqual(normalized.pcs[0].fast, pcFast);
  assert.deepEqual(normalized.inputs[2].fast, inputFast);
  assert.equal(normalized.inputs[0].fast, undefined);
  assert.equal(normalizeStatus(status).pcs[0].fast, undefined, 'status from older firmware remains valid');
});

test('normalizeStatus accepts bounded candidates with a positive generation', () => {
  const withCandidates = normalizeStatus({
    ...status,
    candidateGeneration: 12,
    candidates: [
      { id: 1, name: null, address: 'AA:BB:CC:DD:EE:01', rssi: -48 },
      { id: 8, name: 'Keyboard', address: 'AA:BB:CC:DD:EE:08', rssi: -71 },
    ],
  });
  assert.equal(withCandidates.candidateGeneration, 12);
  assert.equal(withCandidates.candidates[0].name, null);
  assert.equal(withCandidates.candidates[1].id, 8);
  assert.throws(() => normalizeStatus({ ...status, candidates: [{ id: 1, name: null, address: 'x', rssi: -1 }] }), /positive candidateGeneration/i);
  assert.throws(() => normalizeStatus({ ...status, candidateGeneration: 1, candidates: [{ id: 9, name: null, address: 'x', rssi: -1 }] }), /candidates\[0\]\.id/i);
  assert.throws(() => normalizeStatus({ ...status, candidateGeneration: 1, candidates: [
    { id: 1, name: null, address: 'x', rssi: -1 },
    { id: 1, name: null, address: 'y', rssi: -2 },
  ] }), /unique/i);
});

test('user-facing mappers hide protocol error and operation codes', () => {
  assert.equal(describeUiState('select-slot'), '入力枠を選択中');
  assert.equal(describeOperation('pair'), '登録');
  assert.equal(describeOperation('forget'), '登録解除');
  assert.equal(describeResult('success'), '処理が完了しました。');
  assert.equal(describeResult('timeout'), '時間切れです。登録は完了していません。');
  assert.equal(describeResult('confirmation-timeout'), '確認の時間が切れました。登録は変更していません。');
  assert.equal(describeResult('input_pairing_unavailable'), '入力機器の登録を開始できませんでした。');
  assert.equal(describeResult('本体が応答しませんでした。'), '本体が応答しませんでした。');
  assert.equal(describeError('input_pairing_unavailable'), '入力機器の登録を開始できませんでした。');
  assert.equal(describeError('nvs'), '本体への保存に失敗しました。');
  assert.equal(describeError('unrecognized_protocol_code'), '本体が要求を受け付けませんでした。');
});

test('classifyResult keeps success, failure, and cancellation LED meanings distinct', () => {
  assert.equal(classifyResult('success'), 'success');
  assert.equal(classifyResult('failure'), 'failure');
  assert.equal(classifyResult('timeout'), 'failure');
  assert.equal(classifyResult('busy'), 'failure');
  assert.equal(classifyResult('cancelled'), 'cancelled');
  assert.equal(classifyResult('confirmation-timeout'), 'cancelled');
  assert.equal(classifyResult('some_other_result'), 'none');
});

test('DeviceStateStore clears live status on disconnect', () => {
  const store = new DeviceStateStore();
  assert.equal(store.snapshot().connected, false);
  store.markConnected();
  store.applyStatus(status);
  assert.equal(store.snapshot().status.selectedPc, 2);
  store.markDisconnected();
  assert.deepEqual(store.snapshot(), { connected: false, status: null });
});

test('buildCommand emits exact v2 commands and rejects injection', () => {
  assert.equal(buildCommand('status'), 'status');
  assert.equal(buildCommand('select', 3), 'select 3');
  assert.equal(buildCommand('pair', 'pc', 1), 'pair pc 1');
  assert.equal(buildCommand('pair', 'input', 'm2'), 'pair input m2');
  assert.equal(buildCommand('replace', 'pc', 2), 'replace pc 2');
  assert.equal(buildCommand('replace', 'input', 'k1'), 'replace input k1');
  assert.equal(buildCommand('forget', 'all'), 'forget all');
  assert.equal(buildCommand('forget', 'input', 'k2'), 'forget input k2');
  assert.equal(buildCommand('confirm', 42), 'confirm 42');
  assert.equal(buildCommand('assign', 'input', 4, 'm1'), 'assign input 4 m1');
  assert.equal(buildCommand('choose', 'input', 12, 8), 'choose input 12 8');
  assert.equal(buildCommand('cancel'), 'cancel');
  assert.throws(() => buildCommand('select', 0), /PC/i);
  assert.throws(() => buildCommand('confirm', 0), /positive/i);
  assert.throws(() => buildCommand('choose', 'input', 0, 1), /generation/i);
  assert.throws(() => buildCommand('choose', 'input', 12, 9), /candidate ID/i);
  assert.throws(() => buildCommand('choose', 'input', '12\nforget all', 1), /generation/i);
  assert.throws(() => buildCommand('pair', 'input', 'm2\nforget all'), /key/i);
  assert.throws(() => buildCommand('confirm', '1\nstatus'), /confirmation/i);
});

test('slot selection breathes in cyan, while each input pairing retains its pulse count', () => {
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 0), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 500), [0, 12, 12]);
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 1000), LED_COLORS.mouse);
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 1500), [0, 12, 12]);
  for (const [target, count, color] of [['k1', 1, LED_COLORS.keyboard], ['k2', 2, LED_COLORS.keyboard], ['m1', 3, LED_COLORS.mouse], ['m2', 4, LED_COLORS.mouse]]) {
    const state = { state: 'pairing', target };
    assert.deepEqual(rgbAt(state, (count - 1) * 300), color);
    assert.deepEqual(rgbAt(state, count * 300), LED_COLORS.off);
    assert.deepEqual(rgbAt(state, (count + 1) * 300), color);
  }
  const selection = normalizeStatus({ ...status, ui: { ...status.ui, state: 'select-slot', target: null, remainingMs: 8000 } });
  assert.equal(selection.ui.state, 'select-slot');
  assert.equal(selection.ui.target, null);
});

test('rgbAt keeps target and purple confirmation phases coherent', () => {
  const state = { state: 'confirm', target: 'pc2' };
  assert.deepEqual(rgbAt(state, 0), LED_COLORS.pc2);
  assert.deepEqual(rgbAt(state, 150), LED_COLORS.off);
  assert.deepEqual(rgbAt(state, 300), LED_COLORS.pc2);
  assert.deepEqual(rgbAt(state, 600), LED_COLORS.off);
  assert.deepEqual(rgbAt(state, 900), LED_COLORS.confirm);
  assert.deepEqual(rgbAt(state, 1499), LED_COLORS.confirm);
  assert.deepEqual(rgbAt(state, 1500), LED_COLORS.off);
  assert.deepEqual(rgbAt(state, 3000), LED_COLORS.pc2);
});

test('rgbAt distinguishes solid, breathing, unregistered, and pairing states', () => {
  assert.deepEqual(rgbAt({ state: 'normal', selectedPc: 1, registered: true, connected: true }, 123), LED_COLORS.pc1);
  assert.deepEqual(rgbAt({ state: 'normal', selectedPc: 1, registered: true, connected: false }, 0), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'normal', selectedPc: 1, registered: true, connected: false }, 1000), LED_COLORS.pc1);
  assert.deepEqual(rgbAt({ state: 'normal', selectedPc: 1, registered: false, connected: false }, 0), LED_COLORS.pc1);
  assert.deepEqual(rgbAt({ state: 'normal', selectedPc: 1, registered: false, connected: false }, 600), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'pairing', target: 'pc3' }, 249), LED_COLORS.pc3);
  assert.deepEqual(rgbAt({ state: 'pairing', target: 'pc3' }, 250), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'pairing', target: 'k2' }, 900), LED_COLORS.keyboard);
  assert.deepEqual(rgbAt({ state: 'pairing', target: 'k2' }, 1500), LED_COLORS.off);
});

test('rgbAt keeps confirmation expiry dark while registration timeout uses white failure flashes', () => {
  const previous = { state: 'normal', selectedPc: 1, registered: true, connected: true };
  assert.deepEqual(rgbAt({ state: 'cancel', previous }, 0), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'cancel', previous }, 199), LED_COLORS.off);
  assert.deepEqual(rgbAt({ state: 'cancel', previous }, 200), LED_COLORS.pc1);
  assert.deepEqual(rgbAt({ state: 'failure', previous }, 0), LED_COLORS.result);
});

test('SerialCommandWriter serializes writes and appends one newline', async () => {
  const writes = [];
  const writer = {
    async write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
  };
  const queue = new SerialCommandWriter(writer);
  await Promise.all([queue.send('pair pc 1'), queue.send('status'), queue.send('cancel')]);
  assert.deepEqual(writes, ['pair pc 1\n', 'status\n', 'cancel\n']);
});

test('SerialClient expires a silent open UART and reacquires a later status', async () => {
  const clock = makeFakeClock();
  const openPort = makeOpenPort();
  const store = new DeviceStateStore();
  const client = new SerialClient({
    serial: { requestPort: async () => openPort.port },
    store,
    clock,
  });

  await client.connect(openPort.port);
  assert.equal(store.snapshot().connected, true);
  clock.tick(STATUS_STALE_AFTER_MS - 1);
  assert.equal(store.snapshot().connected, true);
  clock.tick(2);
  assert.deepEqual(store.snapshot(), { connected: false, status: null });

  const writesBeforeRecoveryPoll = openPort.writes.length;
  clock.tick(1000);
  await flushMicrotasks();
  assert.ok(openPort.writes.length > writesBeforeRecoveryPoll, 'status polling continues after stale state is cleared');
  openPort.enqueue(status);
  await flushMicrotasks();
  assert.equal(store.snapshot().status.selectedPc, 2);
  await client.disconnect();
});

test('SerialClient clears status after a poll write error without closing the UART', async () => {
  const clock = makeFakeClock();
  const openPort = makeOpenPort();
  const store = new DeviceStateStore();
  const client = new SerialClient({ serial: { requestPort: async () => openPort.port }, store, clock });

  await client.connect(openPort.port);
  openPort.enqueue(status);
  await flushMicrotasks();
  assert.equal(store.snapshot().status.selectedPc, 2);

  openPort.setWriteFailure(true);
  clock.tick(1000);
  await flushMicrotasks();
  assert.deepEqual(store.snapshot(), { connected: false, status: null });
  assert.equal(client.port, openPort.port, 'a failed poll does not discard the open transport');

  openPort.setWriteFailure(false);
  clock.tick(1000);
  await flushMicrotasks();
  openPort.enqueue(status);
  await flushMicrotasks();
  assert.equal(store.snapshot().status.selectedPc, 2);
  await client.disconnect();
});

test('SerialClient clears stale state when the read loop closes unexpectedly', async () => {
  let closed = false;
  const port = {
    readable: new ReadableStream({
      start(controller) {
        setTimeout(() => controller.close(), 5);
      },
    }),
    writable: new WritableStream({ write() {} }),
    async open(options) {
      assert.deepEqual(options, { baudRate: 115200 });
    },
    async close() {
      closed = true;
    },
  };
  const store = new DeviceStateStore();
  const client = new SerialClient({ serial: { requestPort: async () => port }, store });
  await client.connect(port);
  store.applyStatus(status);
  await new Promise((resolve, reject) => {
    const unsubscribe = client.on('disconnected', () => {
      unsubscribe();
      resolve();
    });
    setTimeout(() => reject(new Error('read loop did not close')), 100);
  });
  assert.equal(closed, true);
  assert.deepEqual(store.snapshot(), { connected: false, status: null });
});


test('configuration status preserves independent PC OS and layout and four physical layouts', () => {
  const config = { inputLayouts: ['us', 'jis', 'us', 'jis'], outputLayouts: ['jis', 'us', 'us'], outputOs: ['windows', 'macos', 'unspecified'] };
  assert.deepEqual(normalizeStatus({ ...status, config }).config, { ...config, buttonOrder: null });
  assert.equal(normalizeStatus(status).config, null, 'old firmware must not invent saved settings');
  for (const bad of [ { ...config, outputOs: ['auto', 'macos', 'linux'] }, { ...config, inputLayouts: ['us'] }, { ...config, outputLayouts: ['us', 'jis', 'dvorak'] } ]) {
    assert.throws(() => normalizeStatus({ ...status, config: bad }));
  }
});

test('button order status retains valid custom orders and handles older firmware', () => {
  const config = { inputLayouts: ['us', 'jis', 'us', 'jis'], outputLayouts: ['jis', 'us', 'us'], outputOs: ['windows', 'macos', 'unspecified'] };
  assert.equal(normalizeStatus({ ...status, config }).config.buttonOrder, null);
  for (const order of ['123M', 'M321', '2M13']) {
    assert.equal(normalizeStatus({ ...status, config: { ...config, buttonOrder: order } }).config.buttonOrder, order);
  }
  for (const order of ['112M', '1234', 'M321x', 'm321', null, 1234]) {
    assert.throws(() => normalizeStatus({ ...status, config: { ...config, buttonOrder: order } }), /buttonOrder/);
  }
});

test('button order commands validate permutations and supported aliases', () => {
  for (const order of ['123M', 'M321', '2M13', 'normal', 'reversed']) {
    assert.equal(buildCommand('set-buttons', order), `set buttons ${order}`);
  }
  for (const order of ['112M', '1234', 'M321x', 'm321', '', '123M\nforget all']) {
    assert.throws(() => buildCommand('set-buttons', order));
  }
  assert.throws(() => buildCommand('set-buttons', '123M', 'extra'));
});

test('button order choices display presets and preserve a custom saved value', () => {
  assert.deepEqual(buttonOrderChoices('123M'), ['123M', 'M321']);
  assert.deepEqual(buttonOrderChoices('2M13'), ['123M', 'M321', '2M13']);
  assert.equal(buttonOrderLabel('123M'), '標準（123M）');
  assert.equal(buttonOrderLabel('M321'), '逆（M321）');
  assert.equal(buttonOrderLabel('2M13'), '2M13');
});

test('configuration commands validate layouts, destination OS, and physical input slots', () => {
  assert.equal(buildCommand('set', 'pc', 2, 'layout', 'jis'), 'set pc 2 layout jis');
  assert.equal(buildCommand('set', 'input', 4, 'layout', 'us'), 'set input 4 layout us');
  for (const os of ['unspecified', 'windows', 'macos', 'linux']) {
    assert.equal(buildCommand('set', 'pc', 1, 'os', os), `set pc 1 os ${os}`);
  }
  for (const args of [['input', 1, 'os', 'windows'], ['pc', 0, 'os', 'macos'], ['pc', 1, 'os', 'auto'], ['input', 'k1', 'layout', 'us'], ['pc', 1, 'layout', 'us\nforget all']]) {
    assert.throws(() => buildCommand('set', ...args));
  }
});
