import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResult,
  BluetoothClient,
  DeviceStateStore,
  describeError,
  describeOperation,
  describeResult,
  describeUiState,
  LED_COLORS,
  LineParser,
  SerialClient,
  SerialCommandWriter,
  BLE_CONFIG_SERVICE_UUID,
  STATUS_STALE_AFTER_MS,
  buildCommand,
  buttonOrderChoices,
  buttonOrderLabel,
  configurationFieldPolicy,
  normalizeStatus,
  rgbAt,
  switchKeysProblem,
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
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, interval: null, next: now + delay });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.next <= target)
          .sort((left, right) => left[1].next - right[1].next)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.next;
        if (timer.interval === null) timers.delete(id);
        else timer.next += timer.interval;
        timer.callback();
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

function makeFakeBleDevice({ name = 'HID Hub', onWrite = null } = {}) {
  const writes = [];
  const listeners = new Map();
  let autoRespond = true;
  let failNextConnect = false;
  const txListeners = new Map();

  const tx = {
    async startNotifications() { return this; },
    addEventListener(type, listener) {
      const set = txListeners.get(type) ?? new Set();
      set.add(listener);
      txListeners.set(type, set);
    },
    removeEventListener(type, listener) { txListeners.get(type)?.delete(listener); },
    notify(text, splitAt = null) {
      const bytes = new TextEncoder().encode(text);
      const ranges = splitAt === null ? [[0, bytes.length]] : [[0, splitAt], [splitAt, bytes.length]];
      for (const [start, end] of ranges) {
        if (start === end) continue;
        const chunk = bytes.slice(start, end);
        const value = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const listener of txListeners.get('characteristicvaluechanged') ?? []) {
          listener({ target: { value } });
        }
      }
    },
    respondStatus() {
      const response = `${JSON.stringify(status)}\n{"ok":true}\n`;
      this.notify(response, 23);
    },
    respondOk() { this.notify('{"ok":true}\n'); },
  };

  const rx = {
    async writeValueWithResponse(bytes) {
      const line = new TextDecoder().decode(bytes);
      writes.push(line);
      if (onWrite) await onWrite(line, tx);
      else if (autoRespond) {
        if (line === 'status\n') tx.respondStatus();
        else tx.respondOk();
      }
    },
  };
  const service = {
    async getCharacteristic(uuid) {
      if (uuid === 'f702bda6-2d20-4f9b-97de-1074f69db11a') return rx;
      if (uuid === 'f702bda7-2d20-4f9b-97de-1074f69db11a') return tx;
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };
  const server = {
    async getPrimaryService(uuid) {
      assert.equal(uuid, BLE_CONFIG_SERVICE_UUID);
      return service;
    },
  };
  const gatt = {
    connected: false,
    connectAttempts: 0,
    disconnectCalls: 0,
    async connect() {
      this.connectAttempts += 1;
      if (failNextConnect) {
        failNextConnect = false;
        throw new Error('saved GATT link unavailable');
      }
      this.connected = true;
      return server;
    },
    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
      for (const listener of listeners.get('gattserverdisconnected') ?? []) {
        listener({ target: device });
      }
    },
  };
  const device = {
    id: `${name}-id`,
    name,
    gatt,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    disconnectRemote() { gatt.disconnect(); },
  };
  device.writes = writes;
  device.tx = tx;
  device.setAutoRespond = (value) => { autoRespond = value; };

  return {
    device,
    tx,
    writes,
    setAutoRespond(value) { autoRespond = value; },
    failNextConnect() { failNextConnect = true; },
  };
}

function makeFakeBluetooth({ permittedDevices = [], chooserDevice = makeFakeBleDevice().device } = {}) {
  const calls = { getDevices: 0, requestDevice: 0, requestOptions: null };
  return {
    calls,
    device: chooserDevice,
    writes: chooserDevice.writes,
    bluetooth: {
      async getDevices() {
        calls.getDevices += 1;
        return permittedDevices;
      },
      async requestDevice(options) {
        calls.requestDevice += 1;
        calls.requestOptions = options;
        if (!chooserDevice) throw new Error('no chooser device');
        return chooserDevice;
      },
    },
  };
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
  assert.equal(normalized.needsReboot, false, 'older firmware status remains compatible');
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

test('normalizeStatus carries reboot and keyboard interval policy status', () => {
  const normalized = normalizeStatus({
    ...status,
    needsReboot: true,
    inputs: status.inputs.map((entry, index) => index === 0
      ? { ...entry, intervalPolicyGaveUp: true, peerIntervalRejections: 7 }
      : entry),
  });
  assert.equal(normalized.needsReboot, true);
  assert.equal(normalized.inputs[0].intervalPolicyGaveUp, true);
  assert.equal(normalized.inputs[0].peerIntervalRejections, 7);
  const withLegacyCount = normalizeStatus({
    ...status,
    legacyInputs: [{ slot: 4, registered: true, connected: false, intervalPolicyGaveUp: false, peerIntervalRejections: 3 }],
  });
  assert.equal(withLegacyCount.legacyInputs[0].peerIntervalRejections, 3);
  assert.throws(() => normalizeStatus({ ...status, needsReboot: 1 }), /needsReboot/i);
  assert.throws(() => normalizeStatus({
    ...status,
    inputs: status.inputs.map((entry, index) => index === 0 ? { ...entry, peerIntervalRejections: -1 } : entry),
  }), /peerIntervalRejections/i);
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
  assert.equal(normalized.pcs[0].intervalUs, 11250);
  assert.equal(normalized.inputs[0].intervalUs, 7500);
  assert.equal(normalized.inputs[0].fast, undefined);
  assert.equal(normalizeStatus(status).pcs[0].fast, undefined, 'status from older firmware remains valid');
  assert.throws(() => normalizeStatus({
    ...status,
    pcs: status.pcs.map((entry, index) => index === 0 ? { ...entry, intervalUs: -1 } : entry),
  }), /intervalUs/i);
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
  assert.equal(describeResult('bond-store-full'), '本体のbond保存領域が満杯です。新しい登録は完了せず、以前の登録は保持されています。');
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
  assert.equal(classifyResult('bond-store-full'), 'failure');
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

test('BluetoothClient joins split notifications into status and shares the USB state store', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const store = new DeviceStateStore();
  const bluetoothClient = new BluetoothClient({ bluetooth: fake.bluetooth, store, clock });
  const usbClient = new SerialClient({ serial: null, store, clock });

  await bluetoothClient.connect();

  assert.strictEqual(bluetoothClient.store, usbClient.store);
  assert.equal(store.snapshot().connected, true);
  assert.equal(store.snapshot().status.selectedPc, 2);
  assert.deepEqual(fake.writes, ['status\n']);
  assert.deepEqual(fake.calls.requestOptions, {
    filters: [{ services: [BLE_CONFIG_SERVICE_UUID] }],
  });
  await bluetoothClient.disconnect();
});

test('BluetoothClient opens the service chooser without calling unsupported getDevices', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const bluetooth = { requestDevice: fake.bluetooth.requestDevice };
  const client = new BluetoothClient({ bluetooth, clock });

  await client.connect();

  assert.equal(fake.calls.getDevices, 0);
  assert.equal(fake.calls.requestDevice, 1);
  assert.deepEqual(fake.calls.requestOptions, {
    filters: [{ services: [BLE_CONFIG_SERVICE_UUID] }],
  });
  await client.disconnect();
});

test('BluetoothClient times out the combined GATT connection and initial status wait after eight seconds', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const store = new DeviceStateStore();
  const client = new BluetoothClient({ bluetooth: fake.bluetooth, store, clock, commandTimeoutMs: 20000 });
  fake.device.setAutoRespond(false);

  const connectGatt = fake.device.gatt.connect.bind(fake.device.gatt);
  let finishGattConnect;
  fake.device.gatt.connect = () => new Promise((resolve, reject) => {
    finishGattConnect = async () => {
      try {
        resolve(await connectGatt());
      } catch (error) {
        reject(error);
      }
    };
  });

  let connectionError = null;
  let settled = false;
  const connection = client.connect().catch((error) => {
    connectionError = error;
  }).finally(() => { settled = true; });

  try {
    await flushMicrotasks();
    clock.tick(7000);
    await finishGattConnect();
    await flushMicrotasks();
    assert.deepEqual(fake.writes, ['status\n']);
    clock.tick(999);
    await flushMicrotasks();
    assert.equal(settled, false);
    clock.tick(1);
    await flushMicrotasks();

    assert.equal(settled, true);
    assert.equal(connectionError?.message, '接続できませんでした。機器の一覧に HID Hub が 2 つあるときは、もう一方を選んでください。');
    assert.equal(fake.device.gatt.connected, false);
    assert.equal(fake.device.gatt.disconnectCalls, 1);
    assert.deepEqual(store.snapshot(), { connected: false, status: null });
  } finally {
    if (!settled) {
      clock.tick(30000);
      await flushMicrotasks();
    }
    await connection;
  }

  fake.device.gatt.connect = connectGatt;
  fake.device.setAutoRespond(true);
  await client.connect();
  assert.equal(store.snapshot().connected, true);
  await client.disconnect();
});

test('BluetoothClient reuses a granted Hub first and falls back to the chooser if reconnect fails', async () => {
  const clock = makeFakeClock();
  const granted = makeFakeBleDevice();
  const chooser = makeFakeBleDevice({ name: 'HID Hub Config' });
  granted.failNextConnect();
  const fake = makeFakeBluetooth({
    permittedDevices: [granted.device],
    chooserDevice: chooser.device,
  });
  const client = new BluetoothClient({ bluetooth: fake.bluetooth, clock });

  await client.connect();

  assert.equal(granted.device.gatt.connectAttempts, 1);
  assert.equal(chooser.device.gatt.connectAttempts, 1);
  assert.equal(fake.calls.getDevices, 1);
  assert.equal(fake.calls.requestDevice, 1);
  assert.equal(client.device, chooser.device);
  await client.disconnect();
});

test('BluetoothClient waits for each response and serializes user commands with status refreshes', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const client = new BluetoothClient({ bluetooth: fake.bluetooth, clock });
  await client.connect();
  fake.device.setAutoRespond(false);

  const select = client.send('select 2');
  const setButtons = client.send('set buttons M321');
  const cancel = client.send('cancel');
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, ['status\n', 'select 2\n']);
  assert.deepEqual(fake.calls, {
    getDevices: 1,
    requestDevice: 1,
    requestOptions: {
      filters: [{ services: [BLE_CONFIG_SERVICE_UUID] }],
    },
  });
  fake.device.tx.respondOk();
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, ['status\n', 'select 2\n', 'status\n']);
  fake.device.tx.respondStatus();
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, ['status\n', 'select 2\n', 'status\n', 'set buttons M321\n']);
  fake.device.tx.respondOk();
  await flushMicrotasks();
  fake.device.tx.respondStatus();
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, [
    'status\n', 'select 2\n', 'status\n', 'set buttons M321\n', 'status\n', 'cancel\n',
  ]);
  fake.device.tx.respondOk();
  await flushMicrotasks();
  fake.device.tx.respondStatus();
  await Promise.all([select, setButtons, cancel]);
  await client.disconnect();
});

test('BluetoothClient disconnect event clears status and stops sends', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const store = new DeviceStateStore();
  const client = new BluetoothClient({ bluetooth: fake.bluetooth, store, clock });
  let disconnected = 0;
  client.on('disconnected', () => { disconnected += 1; });
  await client.connect();

  fake.device.disconnectRemote();
  await flushMicrotasks();

  assert.equal(disconnected, 1);
  assert.deepEqual(store.snapshot(), { connected: false, status: null });
  await assert.rejects(client.send('status'), /not connected/i);
});

test('BluetoothClient sends the next periodic status five seconds after the full response', async () => {
  const clock = makeFakeClock();
  const fake = makeFakeBluetooth();
  const client = new BluetoothClient({ bluetooth: fake.bluetooth, clock });
  await client.connect();

  clock.tick(4999);
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, ['status\n']);

  clock.tick(1);
  await flushMicrotasks();
  assert.deepEqual(fake.device.writes, ['status\n', 'status\n']);
  await client.disconnect();
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
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 1000), LED_COLORS.selectSlot);
  assert.deepEqual(rgbAt({ state: 'select-slot' }, 1500), [0, 12, 12]);
  for (const [target, count, color] of [['k1', 1, LED_COLORS.keyboard], ['k2', 2, LED_COLORS.keyboard], ['m1', 1, LED_COLORS.mouse], ['m2', 2, LED_COLORS.mouse]]) {
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
  assert.deepEqual(normalizeStatus({ ...status, config }).config, {
    ...config,
    inputMacDeleteSwap: [false, false, false, false],
    inputMacDeleteSwapSupported: false,
    buttonOrder: null,
  });
  assert.equal(normalizeStatus(status).config, null, 'old firmware must not invent saved settings');
  for (const bad of [ { ...config, outputOs: ['auto', 'macos', 'linux'] }, { ...config, inputLayouts: ['us'] }, { ...config, outputLayouts: ['us', 'jis', 'dvorak'] } ]) {
    assert.throws(() => normalizeStatus({ ...status, config: bad }));
  }
});

test('configuration status preserves four physical Mac Delete and Back Space swap settings', () => {
  const config = {
    inputLayouts: ['us', 'jis', 'us', 'jis'],
    inputMacDeleteSwap: [false, true, false, true],
    outputLayouts: ['jis', 'us', 'us'],
    outputOs: ['windows', 'macos', 'unspecified'],
  };
  assert.deepEqual(normalizeStatus({ ...status, config }).config, {
    ...config,
    inputMacDeleteSwapSupported: true,
    buttonOrder: null,
  });
  assert.deepEqual(
    normalizeStatus({ ...status, config: { ...config, inputMacDeleteSwap: undefined } }).config.inputMacDeleteSwap,
    [false, false, false, false],
    'firmware without this setting defaults every physical input off',
  );
  assert.equal(
    normalizeStatus({ ...status, config: { ...config, inputMacDeleteSwap: undefined } }).config.inputMacDeleteSwapSupported,
    false,
  );
  for (const bad of [[true, false], [false, 1, false, false], ['off', false, false, false]]) {
    assert.throws(() => normalizeStatus({ ...status, config: { ...config, inputMacDeleteSwap: bad } }));
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

test('button order editing over Bluetooth is disabled and points users to USB', () => {
  assert.deepEqual(configurationFieldPolicy('buttons', 'bluetooth'), {
    disabled: true,
    guidance: 'Bluetooth接続中はボタンの並びを変更できません。USBで接続してください。',
  });
  assert.deepEqual(configurationFieldPolicy('buttons', 'usb'), {
    disabled: false,
    guidance: '',
  });
  assert.deepEqual(configurationFieldPolicy('pc', 'bluetooth'), {
    disabled: false,
    guidance: '',
  });
  for (const transport of ['bluetooth', 'usb']) {
    assert.deepEqual(configurationFieldPolicy('input', transport), {
      disabled: false,
      guidance: '',
    });
  }
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

test('configuration commands build Mac Delete and Back Space swap changes for physical inputs', () => {
  assert.equal(buildCommand('set', 'input', 1, 'mac-delete-swap', 'on'), 'set input 1 mac-delete-swap on');
  assert.equal(buildCommand('set', 'input', 4, 'mac-delete-swap', 'off'), 'set input 4 mac-delete-swap off');
  for (const args of [
    ['input', 0, 'mac-delete-swap', 'on'],
    ['input', 5, 'mac-delete-swap', 'off'],
    ['pc', 1, 'mac-delete-swap', 'on'],
    ['input', 1, 'mac-delete-swap', 'yes'],
  ]) {
    assert.throws(() => buildCommand('set', ...args));
  }
});


test('PC switch shortcut keys: command, validation and status', () => {
  assert.equal(buildCommand('set-shortcut-keys', ['a', 's', 'd']), 'set shortcut-keys a,s,d');
  assert.equal(buildCommand('set-shortcut-keys', ['q', 'f5', '7']), 'set shortcut-keys q,f5,7');
  for (const bad of [['a', 'a', 'd'], ['a', 's'], ['a', 's', 'd', 'f'], ['a', 's', 'space'], ['A', 's', 'd'], 'a,s,d']) {
    assert.throws(() => buildCommand('set-shortcut-keys', bad), bad.toString());
  }
  assert.equal(buildCommand('set-shortcut-default'), 'set shortcut ctrl-alt-shift-digits');
  assert.equal(switchKeysProblem(['a', 's', 'd']), null);
  assert.match(switchKeysProblem(['a', 'a', 'd']), /同じキー/);
  const config = { inputLayouts: ['us', 'jis', 'us', 'jis'], outputLayouts: ['jis', 'us', 'us'], outputOs: ['windows', 'macos', 'unspecified'] };
  const keys = normalizeStatus({ ...status, config: { ...config, shortcut: 'ctrl-alt-shift-keys', shortcutKeys: ['a', 's', 'd'] } }).config;
  assert.deepEqual(keys.shortcutKeys, ['a', 's', 'd']);
  assert.equal(keys.shortcut, 'ctrl-alt-shift-keys');
  const other = normalizeStatus({ ...status, config: { ...config, shortcut: 'ctrl-alt-shift-digits', shortcutKeys: [] } }).config;
  assert.deepEqual(other.shortcutKeys, []);
  assert.equal(normalizeStatus({ ...status, config }).config.shortcutKeys, undefined, 'older firmware has no shortcut keys');
  for (const bad of [['a', 'a', 'd'], ['a', 's'], ['a', 's', 'space']]) {
    assert.throws(() => normalizeStatus({ ...status, config: { ...config, shortcut: 'x', shortcutKeys: bad } }));
  }
});
