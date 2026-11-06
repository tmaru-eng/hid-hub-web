/**
 * Protocol and transport helpers for the HID hub configuration screen.
 *
 * The browser never invents a live state.  A status is accepted only when it
 * is a complete protocol-v2 status response; when the serial link goes away,
 * DeviceStateStore deliberately drops the last status.
 */

export const INPUT_KEYS = Object.freeze(['k1', 'k2', 'm1', 'm2']);
export const PC_COUNT = 3;
export const PHYSICAL_INPUT_COUNT = 4;
export const SERIAL_BAUD_RATE = 115200;
export const BLE_CONFIG_SERVICE_UUID = 'f702bda5-2d20-4f9b-97de-1074f69db11a';
export const BLE_CONFIG_RX_UUID = 'f702bda6-2d20-4f9b-97de-1074f69db11a';
export const BLE_CONFIG_TX_UUID = 'f702bda7-2d20-4f9b-97de-1074f69db11a';
export const BLUETOOTH_NAME_PREFIX = 'HID Hub';
export const BLUETOOTH_STATUS_POLL_INTERVAL_MS = 5000;
export const BLUETOOTH_STATUS_STALE_AFTER_MS = 12000;
export const BLUETOOTH_CONNECT_TIMEOUT_MS = 8000;
export const BLUETOOTH_CONNECT_TIMEOUT_MESSAGE = '接続できませんでした。機器の一覧に HID Hub が 2 つあるときは、もう一方を選んでください。';
export const BLUETOOTH_COMMAND_TIMEOUT_MS = 12000;
// A UART can stay open while the board has reset or stopped answering.  Keep
// polling so a later status can recover, but never keep showing the last
// status beyond this bounded freshness window.
export const STATUS_STALE_AFTER_MS = 3500;
export const STATUS_WATCHDOG_INTERVAL_MS = 500;
export const LED_COLORS = Object.freeze({
  off: Object.freeze([0, 0, 0]),
  pc1: Object.freeze([32, 0, 0]),
  pc2: Object.freeze([0, 32, 0]),
  pc3: Object.freeze([0, 0, 32]),
  keyboard: Object.freeze([32, 32, 0]),
  mouse: Object.freeze([32, 0, 32]),
  selectSlot: Object.freeze([0, 24, 24]),
  confirm: Object.freeze([24, 24, 24]),
  result: Object.freeze([24, 24, 24]),
});

export const LED_TIMING = Object.freeze({
  shortOnMs: 150,
  shortOffMs: 150,
  inputSelectionPeriodMs: 2000,
  registrationPeriodMs: 3000,
  inputRegistrationGapMs: 300,
  longOnMs: 600,
  pcPairOnMs: 250,
  pcPairOffMs: 250,
  resultFlashOnMs: 100,
  resultFlashOffMs: 100,
});

const UI_STATES = new Set(['normal', 'select-slot', 'confirm', 'pairing']);
const OPERATIONS = new Set(['pair', 'forget', 'clear', null]);
const TARGETS = new Set(['pc1', 'pc2', 'pc3', ...INPUT_KEYS, 'all', null]);
const USER_STATE_LABELS = Object.freeze({
  normal: '待機中',
  'select-slot': '入力枠を選択中',
  confirm: '入れ替え確認待ち',
  pairing: '登録処理中',
});
const USER_OPERATION_LABELS = Object.freeze({
  pair: '登録',
  forget: '登録解除',
  clear: '全登録解除',
});
const USER_RESULT_LABELS = Object.freeze({
  success: '処理が完了しました。',
  ok: '本体が処理を受け付けました。',
  paired: '登録が完了しました。',
  saved: '保存が完了しました。',
  complete: '処理が完了しました。',
  done: '処理が完了しました。',
  cancelled: '処理を中止しました。',
  canceled: '処理を中止しました。',
  cancel: '処理を中止しました。',
  'confirmation-timeout': '確認の時間が切れました。登録は変更していません。',
  confirmation_timeout: '確認の時間が切れました。登録は変更していません。',
  timeout: '時間切れです。登録は完了していません。',
  timed_out: '時間切れです。登録は完了していません。',
  'bond-store-full': '本体のbond保存領域が満杯です。新しい登録は完了せず、以前の登録は保持されています。',
  failure: '処理に失敗しました。',
  failed: '処理に失敗しました。',
  error: '処理に失敗しました。',
});
const USER_ERROR_LABELS = Object.freeze({
  busy: '別の登録処理が進行中です。',
  nvs: '本体への保存に失敗しました。',
  invalid_command: '本体が要求を受け付けませんでした。',
  line_too_long: 'コマンドが長すぎます。',
  input_pairing_unavailable: '入力機器の登録を開始できませんでした。',
  pc_pairing_unavailable: 'PCの登録を開始できませんでした。',
  already_registered: 'すでに登録されています。',
  duplicate_peer: '同じ機器が別の枠に登録されています。',
  not_found: '対象の登録が見つかりません。',
  pairing_in_progress: '別の登録処理が進行中です。',
  no_confirmation: '確認できる操作がありません。',
  invalid_confirmation: '確認の有効期限が切れています。',
});

function invalid(message) {
  throw new TypeError(message);
}

function normalizedCode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasJapaneseText(value) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
}

/** Translate firmware state names without exposing protocol vocabulary in the UI. */
export function describeUiState(state) {
  return USER_STATE_LABELS[state] ?? '本体が処理中です';
}

/** Translate firmware operation names for the operation strip. */
export function describeOperation(operation) {
  return USER_OPERATION_LABELS[operation] ?? '処理';
}

/** Translate a result code; unknown protocol codes stay out of normal UI copy. */
export function describeResult(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const code = normalizedCode(raw);
  if (USER_RESULT_LABELS[code]) return USER_RESULT_LABELS[code];
  if (USER_ERROR_LABELS[code]) return USER_ERROR_LABELS[code];
  if (hasJapaneseText(raw)) return raw;
  if (/(timeout|timed[_-]?out|expired|deadline)/.test(code)) return USER_RESULT_LABELS.timeout;
  if (/(cancel|abort)/.test(code)) return USER_RESULT_LABELS.cancelled;
  if (/(fail|error|nvs|unavailable|invalid|reject|denied)/.test(code)) return USER_RESULT_LABELS.failure;
  if (/(success|saved|paired|complete|done|ok)/.test(code)) return USER_RESULT_LABELS.complete;
  return '本体から処理結果を受け取りました。';
}

/** Translate a command/transport error for user-facing copy. Raw values belong in the log only. */
export function describeError(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '本体が要求を処理できませんでした。';
  const code = normalizedCode(raw);
  if (USER_ERROR_LABELS[code]) return USER_ERROR_LABELS[code];
  if (hasJapaneseText(raw)) return raw;
  if (/(not connected|serial|port|disconnected|closed)/.test(code)) return '本体とのUSBシリアル接続を確認してください。';
  if (/(timeout|timed[_-]?out|expired|deadline)/.test(code)) return '本体からの応答が時間内に届きませんでした。';
  if (/(busy|progress|in_progress)/.test(code)) return USER_ERROR_LABELS.busy;
  if (/(invalid|unknown|unrecognized|unsupported)/.test(code)) return USER_ERROR_LABELS.invalid_command;
  return '本体が要求を処理できませんでした。';
}

/** Classify only firmware result codes that have an LED consequence. */
export function classifyResult(value) {
  const code = normalizedCode(value);
  if (code === 'success') return 'success';
  if (['failure', 'failed', 'error', 'timeout', 'timed_out', 'busy', 'bond-store-full'].includes(code)) return 'failure';
  if (['cancel', 'cancelled', 'canceled', 'aborted', 'confirmation-timeout', 'confirmation_timeout'].includes(code)) return 'cancelled';
  return 'none';
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function assertStringOrNull(value, label) {
  if (value !== null && typeof value !== 'string') {
    invalid(`${label} must be string or null`);
  }
  return value;
}

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nullableInteger(value, label, minimum, maximum) {
  return value === null ? null : assertInteger(value, label, minimum, maximum);
}

function normalizePeerRequest(entry, label) {
  assertObject(entry, label);
  return {
    count: assertInteger(entry.count, `${label}.count`, 0, Number.MAX_SAFE_INTEGER),
    minUnits: nullableInteger(entry.minUnits, `${label}.minUnits`, 0, 0xffff),
    maxUnits: nullableInteger(entry.maxUnits, `${label}.maxUnits`, 0, 0xffff),
  };
}

function normalizeFast(entry, label) {
  if (entry === null) return null;
  assertObject(entry, label);
  assertObject(entry.lastUpdate, `${label}.lastUpdate`);
  const normalized = {
    stage: nullableInteger(entry.stage, `${label}.stage`, 0, 0xff),
    targetUnits: assertInteger(entry.targetUnits, `${label}.targetUnits`, 0, 0xffff),
    attempts: assertInteger(entry.attempts, `${label}.attempts`, 0, 0xff),
    pending: assertBoolean(entry.pending, `${label}.pending`),
    requestRc: nullableInteger(entry.requestRc, `${label}.requestRc`, -0x80000000, 0x7fffffff),
    lastUpdate: {
      status: nullableInteger(entry.lastUpdate.status, `${label}.lastUpdate.status`, -0x80000000, 0x7fffffff),
      intervalUs: nullableInteger(entry.lastUpdate.intervalUs, `${label}.lastUpdate.intervalUs`, 0, 0xffffffff),
    },
  };
  if (entry.peerRequests !== undefined) {
    assertObject(entry.peerRequests, `${label}.peerRequests`);
    normalized.peerRequests = {
      connUpdateReq: normalizePeerRequest(entry.peerRequests.connUpdateReq, `${label}.peerRequests.connUpdateReq`),
      l2capUpdateReq: normalizePeerRequest(entry.peerRequests.l2capUpdateReq, `${label}.peerRequests.l2capUpdateReq`),
    };
  }
  return normalized;
}

function normalizeDevice(entry, label, expectedId = undefined) {
  assertObject(entry, label);
  if (expectedId !== undefined && entry.id !== expectedId) {
    invalid(`${label}.id must be ${expectedId}`);
  }
  assertBoolean(entry.registered, `${label}.registered`);
  assertBoolean(entry.connected, `${label}.connected`);
  assertStringOrNull(entry.name, `${label}.name`);
  return {
    ...(expectedId === undefined ? {} : { id: expectedId }),
    registered: entry.registered,
    connected: entry.connected,
    name: entry.name,
    ...(entry.intervalPolicyGaveUp === undefined
      ? {}
      : { intervalPolicyGaveUp: assertBoolean(entry.intervalPolicyGaveUp, `${label}.intervalPolicyGaveUp`) }),
    ...(entry.peerIntervalRejections === undefined
      ? {}
      : { peerIntervalRejections: assertInteger(entry.peerIntervalRejections, `${label}.peerIntervalRejections`, 0, 0xffffffff) }),
    ...(entry.intervalUs === undefined
      ? {}
      : { intervalUs: nullableInteger(entry.intervalUs, `${label}.intervalUs`, 0, 0xffffffff) }),
    ...(entry.fast === undefined ? {} : { fast: normalizeFast(entry.fast, `${label}.fast`) }),
  };
}

function normalizeInput(entry, index) {
  const id = INPUT_KEYS[index];
  const normalized = normalizeDevice(entry, `inputs[${index}]`, id);
  if (entry.slot !== null) assertInteger(entry.slot, `inputs[${index}].slot`, 1, PHYSICAL_INPUT_COUNT);
  return { ...normalized, slot: entry.slot };
}

function normalizeLegacyInput(entry, index) {
  assertObject(entry, `legacyInputs[${index}]`);
  assertInteger(entry.slot, `legacyInputs[${index}].slot`, 1, PHYSICAL_INPUT_COUNT);
  assertBoolean(entry.registered, `legacyInputs[${index}].registered`);
  assertBoolean(entry.connected, `legacyInputs[${index}].connected`);
  return {
    slot: entry.slot,
    registered: entry.registered,
    connected: entry.connected,
    ...(entry.intervalUs === undefined
      ? {}
      : { intervalUs: nullableInteger(entry.intervalUs, `legacyInputs[${index}].intervalUs`, 0, 0xffffffff) }),
    ...(entry.intervalPolicyGaveUp === undefined
      ? {}
      : { intervalPolicyGaveUp: assertBoolean(entry.intervalPolicyGaveUp, `legacyInputs[${index}].intervalPolicyGaveUp`) }),
    ...(entry.peerIntervalRejections === undefined
      ? {}
      : { peerIntervalRejections: assertInteger(entry.peerIntervalRejections, `legacyInputs[${index}].peerIntervalRejections`, 0, 0xffffffff) }),
  };
}

function normalizeCandidate(entry, index) {
  assertObject(entry, `candidates[${index}]`);
  assertInteger(entry.id, `candidates[${index}].id`, 1, 8);
  assertStringOrNull(entry.name, `candidates[${index}].name`);
  if (typeof entry.address !== 'string') invalid(`candidates[${index}].address must be a string`);
  if (!Number.isFinite(entry.rssi)) invalid(`candidates[${index}].rssi must be a finite number`);
  return {
    id: entry.id,
    name: entry.name,
    address: entry.address,
    rssi: entry.rssi,
  };
}

function normalizeUi(value) {
  const ui = assertObject(value, 'ui');
  if (!UI_STATES.has(ui.state)) invalid('ui.state is not a protocol-v2 state');
  if (!TARGETS.has(ui.target)) invalid('ui.target is not a protocol-v2 target');
  if (!OPERATIONS.has(ui.operation)) invalid('ui.operation is not a protocol-v2 operation');
  if (!Number.isFinite(ui.remainingMs) || ui.remainingMs < 0) invalid('ui.remainingMs must be non-negative');
  if (!Number.isInteger(ui.confirmationId) || ui.confirmationId < 0) invalid('ui.confirmationId must be non-negative');
  if (ui.state === 'confirm' && ui.confirmationId === 0) invalid('confirm state requires a positive confirmationId');
  if (typeof ui.result !== 'string') invalid('ui.result must be a string');
  const resultRemainingMs = ui.resultRemainingMs === undefined
    ? (ui.result.length > 0 ? 600 : 0)
    : ui.resultRemainingMs;
  if (!Number.isFinite(resultRemainingMs) || resultRemainingMs < 0) {
    invalid('ui.resultRemainingMs must be non-negative');
  }
  return {
    state: ui.state,
    target: ui.target,
    operation: ui.operation,
    remainingMs: Math.round(ui.remainingMs),
    result: ui.result,
    resultRemainingMs: Math.round(resultRemainingMs),
    confirmationId: ui.confirmationId,
  };
}

export const LAYOUTS = Object.freeze(['us', 'jis']);
/** Keys the firmware accepts for the Ctrl+Alt+Shift PC-switch chord. */
export const SWITCH_KEYS = Object.freeze([
  ...'abcdefghijklmnopqrstuvwxyz'.split(''), '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

/** Null when the keys are valid (one allowed, distinct key per PC), else a Japanese reason. */
export function switchKeysProblem(keys) {
  if (!Array.isArray(keys) || keys.length !== PC_COUNT || keys.some((key) => !SWITCH_KEYS.includes(key))) return 'キーの指定が正しくありません。';
  return new Set(keys).size === keys.length ? null : '同じキーを複数のPCに割り当てることはできません。';
}
export const HOST_OS = Object.freeze(['unspecified', 'windows', 'macos', 'linux']);
export const BUTTON_ORDER_PRESETS = Object.freeze(['123M', 'M321']);

function validButtonOrder(value) {
  return typeof value === 'string' && value.length === 4 && [...value].sort().join('') === '123M';
}

export function buttonOrderLabel(value) {
  return value === '123M' ? '標準（123M）' : value === 'M321' ? '逆（M321）' : value;
}

/** Include a saved custom order so it stays visible until the user changes it. */
export function buttonOrderChoices(saved) {
  return saved && validButtonOrder(saved) && !BUTTON_ORDER_PRESETS.includes(saved)
    ? [...BUTTON_ORDER_PRESETS, saved]
    : [...BUTTON_ORDER_PRESETS];
}

export function configurationFieldPolicy(scope, transport) {
  const requiresUsb = scope === 'buttons' && transport === 'bluetooth';
  return {
    disabled: requiresUsb,
    guidance: requiresUsb
      ? 'Bluetooth接続中はボタンの並びを変更できません。USBで接続してください。'
      : '',
  };
}

function normalizeConfig(value) {
  // Protocol v2 firmware before configuration support supplies no config.
  if (value === undefined) return null;
  assertObject(value, 'config');
  const copy = (key, count, choices) => {
    if (!Array.isArray(value[key]) || value[key].length !== count || value[key].some((entry) => !choices.includes(entry))) invalid(`invalid config.${key}`);
    return [...value[key]];
  };
  const inputMacDeleteSwapSupported = value.inputMacDeleteSwap !== undefined;
  const inputMacDeleteSwap = !inputMacDeleteSwapSupported
    ? Array(PHYSICAL_INPUT_COUNT).fill(false)
    : copy('inputMacDeleteSwap', PHYSICAL_INPUT_COUNT, [false, true]);
  const buttonOrder = value.buttonOrder === undefined ? null : value.buttonOrder;
  if (value.buttonOrder !== undefined && !validButtonOrder(buttonOrder)) invalid('invalid config.buttonOrder');
  // Older firmware has no shortcutKeys; an empty list means the chord is not in per-PC key mode.
  let shortcut = {};
  if (value.shortcutKeys !== undefined) {
    if (typeof value.shortcut !== 'string') invalid('invalid config.shortcut');
    if (!Array.isArray(value.shortcutKeys) || (value.shortcutKeys.length !== 0 && switchKeysProblem(value.shortcutKeys))) invalid('invalid config.shortcutKeys');
    shortcut = { shortcut: value.shortcut, shortcutKeys: [...value.shortcutKeys] };
  }
  return { inputLayouts: copy('inputLayouts', PHYSICAL_INPUT_COUNT, LAYOUTS), inputMacDeleteSwap, inputMacDeleteSwapSupported, outputLayouts: copy('outputLayouts', PC_COUNT, LAYOUTS), outputOs: copy('outputOs', PC_COUNT, HOST_OS), buttonOrder, ...shortcut };
}

/** Validate and copy the complete UART protocol-v2 status object. */
export function normalizeStatus(value) {
  const status = assertObject(value, 'status');
  if (status.protocol !== 2) invalid('status.protocol must be 2');
  assertInteger(status.selectedPc, 'selectedPc', 1, PC_COUNT);
  if (!Array.isArray(status.pcs) || status.pcs.length !== PC_COUNT) invalid('pcs must contain 3 entries');
  if (!Array.isArray(status.inputs) || status.inputs.length !== INPUT_KEYS.length) {
    invalid('inputs must contain 4 entries');
  }
  if (!Array.isArray(status.legacyInputs)) invalid('legacyInputs must be an array');
  const candidateGeneration = status.candidateGeneration === undefined
    ? 0
    : assertInteger(status.candidateGeneration, 'candidateGeneration', 0, Number.MAX_SAFE_INTEGER);
  const rawCandidates = status.candidates === undefined ? [] : status.candidates;
  if (!Array.isArray(rawCandidates)) invalid('candidates must be an array');
  const candidates = rawCandidates.map(normalizeCandidate);
  if (candidates.length > 0 && candidateGeneration === 0) {
    invalid('candidates require a positive candidateGeneration');
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    invalid('candidate IDs must be unique within a generation');
  }
  const pcs = status.pcs.map((entry, index) => normalizeDevice(entry, `pcs[${index}]`));
  const inputs = status.inputs.map(normalizeInput);
  const legacyInputs = status.legacyInputs.map(normalizeLegacyInput);
  const ui = normalizeUi(status.ui);
  const needsReboot = status.needsReboot === undefined
    ? false
    : assertBoolean(status.needsReboot, 'needsReboot');
  return {
    protocol: 2,
    selectedPc: status.selectedPc,
    pcs,
    inputs,
    legacyInputs,
    needsReboot,
    candidateGeneration,
    config: normalizeConfig(status.config),
    candidates,
    ui,
  };
}

/**
 * Incremental newline decoder.  It intentionally classifies text that is not
 * JSON as a log line, while malformed JSON-looking text is kept visible as an
 * invalid-json event.  Neither class is allowed to update device state.
 */
export class LineParser {
  constructor() {
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      this.buffer += this.decoder.decode(bytes, { stream: true });
    } else if (typeof chunk === 'string') {
      this.buffer += chunk;
    } else {
      invalid('serial chunk must be a string or byte array');
    }
    return this.#takeLines();
  }

  flush() {
    this.buffer += this.decoder.decode();
    if (this.buffer.length === 0) return [];
    const line = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    return line.length === 0 ? [] : [classifyLine(line)];
  }

  #takeLines() {
    const events = [];
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) events.push(classifyLine(line));
    }
    return events;
  }
}

function classifyLine(line) {
  try {
    const value = JSON.parse(line);
    if (value !== null && typeof value === 'object') return { kind: 'json', value };
    return { kind: 'log', line };
  } catch {
    return /^[\[{]/.test(line.trim())
      ? { kind: 'invalid-json', line }
      : { kind: 'log', line };
  }
}

/** A tiny state store that makes stale disconnected status impossible. */
export class DeviceStateStore {
  constructor() {
    this.connected = false;
    this.status = null;
    this.listeners = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') invalid('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return { connected: this.connected, status: this.status };
  }

  markConnected() {
    this.connected = true;
    this.#notify();
  }

  applyStatus(value) {
    this.status = normalizeStatus(value);
    this.connected = true;
    this.#notify();
    return this.status;
  }

  markDisconnected() {
    this.connected = false;
    this.status = null;
    this.#notify();
  }

  clearStatus() {
    if (this.status === null) return;
    this.status = null;
    this.#notify();
  }

  #notify() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function assertInputKey(key) {
  if (!INPUT_KEYS.includes(key)) invalid(`input key must be one of ${INPUT_KEYS.join(', ')}`);
  return key;
}

function assertConfirmationId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) invalid('confirmation ID must be a positive integer');
  return id;
}

function phaseAt(timeMs, periodMs) {
  const time = Number.isFinite(timeMs) ? Math.floor(timeMs) : 0;
  return ((time % periodMs) + periodMs) % periodMs;
}

function scaleRgb(rgb, factor) {
  return rgb.map((channel) => Math.round(channel * Math.max(0, Math.min(1, factor))));
}

function targetColor(target) {
  if (target === 'pc1') return LED_COLORS.pc1;
  if (target === 'pc2') return LED_COLORS.pc2;
  if (target === 'pc3') return LED_COLORS.pc3;
  if (target === 'm1' || target === 'm2') return LED_COLORS.mouse;
  if (target === 'k1' || target === 'k2') return LED_COLORS.keyboard;
  return LED_COLORS.off;
}

function targetCount(target) {
  if (target === 'pc1' || target === 'k1' || target === 'm1') return 1;
  if (target === 'pc2' || target === 'k2' || target === 'm2') return 2;
  if (target === 'pc3') return 3;
  return 0;
}

function targetKey(target) {
  if (typeof target === 'string') return target;
  if (Number.isInteger(target) && target >= 1 && target <= PC_COUNT) return `pc${target}`;
  return null;
}

function shortPulse(rgb, count, timeMs, periodMs = LED_TIMING.inputSelectionPeriodMs) {
  const phase = phaseAt(timeMs, periodMs);
  const groupMs = count * (LED_TIMING.shortOnMs + LED_TIMING.shortOffMs);
  if (count <= 0 || phase >= groupMs) return LED_COLORS.off;
  const withinPulse = phase % (LED_TIMING.shortOnMs + LED_TIMING.shortOffMs);
  return withinPulse < LED_TIMING.shortOnMs ? rgb : LED_COLORS.off;
}

function inputRegistration(rgb, count, timeMs) {
  const phase = phaseAt(timeMs, LED_TIMING.registrationPeriodMs);
  const groupMs = count * (LED_TIMING.shortOnMs + LED_TIMING.shortOffMs);
  const longStart = groupMs + LED_TIMING.inputRegistrationGapMs;
  if (phase < groupMs) return shortPulse(rgb, count, phase, LED_TIMING.registrationPeriodMs);
  if (phase >= longStart && phase < longStart + LED_TIMING.longOnMs) return rgb;
  return LED_COLORS.off;
}

function targetConfirm(target, timeMs) {
  const count = targetCount(target);
  const targetRgb = targetColor(target);
  const phase = phaseAt(timeMs, LED_TIMING.registrationPeriodMs);
  const groupMs = count * (LED_TIMING.shortOnMs + LED_TIMING.shortOffMs);
  const longStart = groupMs + LED_TIMING.inputRegistrationGapMs;
  if (phase < groupMs) return shortPulse(targetRgb, count, phase, LED_TIMING.registrationPeriodMs);
  if (phase >= longStart && phase < longStart + LED_TIMING.longOnMs) return LED_COLORS.confirm;
  return LED_COLORS.off;
}

function previousResultColor(state, timeMs) {
  return state.previous && state.previous !== state
    ? rgbAt(state.previous, timeMs)
    : LED_COLORS.off;
}

/**
 * Return the exact RGB value for a firmware LED state at a relative time.
 *
 * State shapes intentionally mirror the protocol where possible:
 * `{state:'normal', selectedPc:1, registered:true, connected:true}`;
 * `{state:'select-slot'}` or `{state:'pairing'|'confirm', target:'k1'}`;
 * and `{state:'success'|'failure', previous:<state>}`. Time is in ms.
 */
export function rgbAt(state, timeMs) {
  if (!state || typeof state !== 'object') return LED_COLORS.off;
  const mode = state.state ?? state.kind;
  const time = Number.isFinite(timeMs) ? timeMs : 0;
  if (mode === 'normal') {
    const selectedPc = targetKey(state.selectedPc ?? state.target);
    const rgb = targetColor(selectedPc);
    if (!rgb.some(Boolean)) return LED_COLORS.off;
    if (state.connected === true) return rgb;
    if (state.registered === false) return shortPulse(rgb, 2, time);
    if (state.registered !== true) return LED_COLORS.off;
    const phase = phaseAt(time, LED_TIMING.inputSelectionPeriodMs);
    const level = phase <= 1000 ? phase / 1000 : (2000 - phase) / 1000;
    return scaleRgb(rgb, level);
  }
  if (mode === 'select-slot') {
    const phase = phaseAt(time, LED_TIMING.inputSelectionPeriodMs);
    const level = phase <= 1000 ? phase : 2000 - phase;
    return LED_COLORS.selectSlot.map((channel) => Math.floor(channel * level / 1000));
  }
  if (mode === 'pairing') {
    const target = targetKey(state.target);
    if (target?.startsWith('pc')) {
      const phase = phaseAt(time, LED_TIMING.pcPairOnMs + LED_TIMING.pcPairOffMs);
      return phase < LED_TIMING.pcPairOnMs ? targetColor(target) : LED_COLORS.off;
    }
    return inputRegistration(targetColor(target), targetCount(target), time);
  }
  if (mode === 'confirm') return targetConfirm(targetKey(state.target), time);
  if (mode === 'success') {
    return time < LED_TIMING.longOnMs ? LED_COLORS.result : previousResultColor(state, time - LED_TIMING.longOnMs);
  }
  if (mode === 'failure') {
    const phase = phaseAt(time, 3 * (LED_TIMING.resultFlashOnMs + LED_TIMING.resultFlashOffMs));
    if (time < 3 * (LED_TIMING.resultFlashOnMs + LED_TIMING.resultFlashOffMs)) {
      return phase % (LED_TIMING.resultFlashOnMs + LED_TIMING.resultFlashOffMs) < LED_TIMING.resultFlashOnMs
        ? LED_COLORS.result
        : LED_COLORS.off;
    }
    return previousResultColor(state, time - 600);
  }
  if (mode === 'cancel') return time < 200 ? LED_COLORS.off : previousResultColor(state, time - 200);
  return LED_COLORS.off;
}

/** Build one exact, newline-free command from the UART v2 contract. */
export function buildCommand(kind, ...args) {
  switch (kind) {
    case 'set-buttons': {
      const [order] = args;
      if (args.length !== 1 || (!validButtonOrder(order) && !['normal', 'reversed'].includes(order))) invalid('invalid button order');
      return `set buttons ${order}`;
    }
    case 'set-shortcut-keys': {
      const [keys] = args;
      if (args.length !== 1 || switchKeysProblem(keys)) invalid('invalid shortcut keys');
      return `set shortcut-keys ${keys.join(',')}`;
    }
    case 'set-shortcut-default':
      if (args.length !== 0) invalid('set-shortcut-default takes no arguments');
      return 'set shortcut ctrl-alt-shift-digits';
    case 'status':
      if (args.length !== 0) invalid('status takes no arguments');
      return 'status';
    case 'set': {
      const [scope, slot, field, value] = args;
      if (args.length !== 4 || !['pc', 'input'].includes(scope)) invalid('set requires pc/input SLOT layout/os VALUE');
      assertInteger(slot, 'slot', 1, scope === 'pc' ? PC_COUNT : PHYSICAL_INPUT_COUNT);
      const choices = field === 'layout'
        ? LAYOUTS
        : field === 'os' && scope === 'pc'
          ? HOST_OS
          : field === 'mac-delete-swap' && scope === 'input'
            ? ['on', 'off']
            : [];
      if (!choices.includes(value)) invalid('unsupported setting or value');
      return `set ${scope} ${slot} ${field} ${value}`;
    }
    case 'select':
      if (args.length !== 1) invalid('select requires a PC number');
      return `select ${assertInteger(args[0], 'PC number', 1, PC_COUNT)}`;
    case 'pair':
    case 'replace': {
      if (args.length !== 2 || (args[0] !== 'pc' && args[0] !== 'input')) {
        invalid(`${kind} requires pc/input and a target`);
      }
      const value = args[0] === 'pc'
        ? assertInteger(args[1], 'PC number', 1, PC_COUNT)
        : assertInputKey(args[1]);
      return `${kind} ${args[0]} ${value}`;
    }
    case 'forget':
      if (args.length === 1 && args[0] === 'all') return 'forget all';
      if (args.length === 2 && args[0] === 'pc') {
        return `forget pc ${assertInteger(args[1], 'PC number', 1, PC_COUNT)}`;
      }
      if (args.length === 2 && args[0] === 'input') return `forget input ${assertInputKey(args[1])}`;
      invalid('forget requires all, pc N, or input KEY');
      break;
    case 'confirm':
      if (args.length !== 1) invalid('confirm requires a confirmation ID');
      return `confirm ${assertConfirmationId(args[0])}`;
    case 'cancel':
      if (args.length !== 0) invalid('cancel takes no arguments');
      return 'cancel';
    case 'assign':
      if (args.length !== 3 || args[0] !== 'input') invalid('assign requires input PHYSICAL KEY');
      return `assign input ${assertInteger(args[1], 'physical slot', 1, PHYSICAL_INPUT_COUNT)} ${assertInputKey(args[2])}`;
    case 'choose':
      if (args.length !== 3 || args[0] !== 'input') invalid('choose requires input GENERATION ID');
      return `choose input ${assertInteger(args[1], 'candidate generation', 1, Number.MAX_SAFE_INTEGER)} ${assertInteger(args[2], 'candidate ID', 1, 8)}`;
    default:
      invalid(`unknown command kind: ${kind}`);
  }
}

/** Serialize writes even when several UI controls are clicked together. */
export class SerialCommandWriter {
  constructor(writer) {
    if (!writer || typeof writer.write !== 'function') invalid('writer must expose write()');
    this.writer = writer;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  send(command) {
    if (this.closed) return Promise.reject(new Error('serial writer is closed'));
    if (typeof command !== 'string' || command.length === 0 || /[\r\n]/.test(command)) {
      return Promise.reject(new TypeError('command must be a non-empty single line'));
    }
    const run = this.tail.catch(() => undefined).then(() => {
      if (this.closed) throw new Error('serial writer is closed');
      return this.writer.write(new TextEncoder().encode(`${command}\n`));
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close() {
    this.closed = true;
    await this.tail;
  }
}

/** Shared line decoding, status normalization, state updates, and events. */
class LineProtocolClient {
  constructor({ store = new DeviceStateStore(), clock = undefined } = {}) {
    this.store = store;
    const suppliedClock = clock ?? {};
    this.clock = {
      now: typeof suppliedClock.now === 'function' ? suppliedClock.now.bind(suppliedClock) : () => Date.now(),
      setInterval: typeof suppliedClock.setInterval === 'function'
        ? suppliedClock.setInterval.bind(suppliedClock)
        : globalThis.setInterval.bind(globalThis),
      clearInterval: typeof suppliedClock.clearInterval === 'function'
        ? suppliedClock.clearInterval.bind(suppliedClock)
        : globalThis.clearInterval.bind(globalThis),
      setTimeout: typeof suppliedClock.setTimeout === 'function'
        ? suppliedClock.setTimeout.bind(suppliedClock)
        : globalThis.setTimeout.bind(globalThis),
      clearTimeout: typeof suppliedClock.clearTimeout === 'function'
        ? suppliedClock.clearTimeout.bind(suppliedClock)
        : globalThis.clearTimeout.bind(globalThis),
    };
    this.parser = new LineParser();
    this.lastStatusAt = null;
    this.listeners = new Map();
  }

  on(event, listener) {
    if (typeof listener !== 'function') invalid('client listener must be a function');
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  _emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  _consumeChunk(chunk) {
    for (const event of this.parser.push(chunk)) this._consumeEvent(event);
  }

  _flushLines() {
    for (const event of this.parser.flush()) this._consumeEvent(event);
  }

  _consumeEvent(event) {
    this._emit('line', event);
    if (event.kind !== 'json') return;
    if (event.value?.protocol === 2) {
      try {
        this.store.applyStatus(event.value);
        this.lastStatusAt = this.clock.now();
        this._emit('status', this.store.snapshot().status);
      } catch (error) {
        this._emit('error', error);
      }
    } else if (Object.prototype.hasOwnProperty.call(event.value ?? {}, 'ok')) {
      this._emit('response', event.value);
    }
  }
}

/**
 * Browser Web Serial adapter. It owns one reader and one writer, polls only
 * while connected, and never retries a user command after a write failure.
 */
export class SerialClient extends LineProtocolClient {
  constructor({ serial = globalThis.navigator?.serial, store = new DeviceStateStore(), clock = undefined } = {}) {
    super({ store, clock });
    this.serial = serial;
    this.port = null;
    this.reader = null;
    this.readTask = null;
    this.writer = null;
    this.pollTimer = null;
    this.statusWatchdogTimer = null;
    this.stopping = false;
  }

  async connect(port = undefined) {
    if (this.port) return this.store.snapshot();
    if (!this.serial?.requestPort && !port) throw new Error('このブラウザは Web Serial に対応していません');
    this.stopping = false;
    this.parser = new LineParser();
    this.port = port ?? await this.serial.requestPort();
    try {
      await this.port.open({ baudRate: SERIAL_BAUD_RATE });
      if (!this.port.readable || !this.port.writable) throw new Error('シリアル入出力を開けません');
      this.writer = new SerialCommandWriter(this.port.writable.getWriter());
      this.store.markConnected();
      this.lastStatusAt = this.clock.now();
      this._emit('connected', this.store.snapshot());
      this.readTask = this.#readLoop(this.port);
      this.pollTimer = this.clock.setInterval(() => this.#pollStatus(), 1000);
      this.statusWatchdogTimer = this.clock.setInterval(
        () => this.#checkStatusFreshness(),
        STATUS_WATCHDOG_INTERVAL_MS,
      );
      await this.send(buildCommand('status'));
      return this.store.snapshot();
    } catch (error) {
      await this.#closeAfterFailure();
      throw error;
    }
  }

  async send(command) {
    if (!this.port || !this.writer || this.stopping) throw new Error('シリアルが接続されていません');
    return this.writer.send(command);
  }

  async disconnect() {
    if (!this.port) {
      this.#clearTimers();
      this.lastStatusAt = null;
      this.store.markDisconnected();
      return;
    }
    this.stopping = true;
    this.#clearTimers();
    this.lastStatusAt = null;
    const port = this.port;
    const reader = this.reader;
    if (reader) await reader.cancel().catch(() => undefined);
    if (this.readTask) await this.readTask.catch(() => undefined);
    if (this.writer) await this.writer.close().catch(() => undefined);
    this.#releaseWriter();
    this.port = null;
    this.readTask = null;
    await port.close().catch(() => undefined);
    this.store.markDisconnected();
    this._emit('disconnected', this.store.snapshot());
  }

  async #closeAfterFailure() {
    const port = this.port;
    this.stopping = true;
    this.#clearTimers();
    this.lastStatusAt = null;
    if (this.reader) await this.reader.cancel().catch(() => undefined);
    if (this.readTask) await this.readTask.catch(() => undefined);
    if (this.writer) await this.writer.close().catch(() => undefined);
    this.#releaseWriter();
    this.port = null;
    this.readTask = null;
    if (port) await port.close().catch(() => undefined);
    this.store.markDisconnected();
  }

  async #handleUnexpectedDisconnect(port) {
    // This is called from #readLoop itself, so it must not await this.readTask.
    // Waiting for the current read task here would deadlock the connection
    // teardown exactly when a browser reports a remote serial close.
    this.stopping = true;
    this.#clearTimers();
    this.lastStatusAt = null;
    if (this.writer) await this.writer.close().catch(() => undefined);
    this.#releaseWriter();
    if (this.port === port) this.port = null;
    await port.close().catch(() => undefined);
    this.store.markDisconnected();
  }

  #releaseWriter() {
    const rawWriter = this.writer?.writer;
    if (rawWriter && typeof rawWriter.releaseLock === 'function') rawWriter.releaseLock();
    this.writer = null;
  }

  #clearTimers() {
    if (this.pollTimer !== null) this.clock.clearInterval(this.pollTimer);
    if (this.statusWatchdogTimer !== null) this.clock.clearInterval(this.statusWatchdogTimer);
    this.pollTimer = null;
    this.statusWatchdogTimer = null;
  }

  async #pollStatus() {
    if (!this.port || this.stopping) return;
    try {
      await this.send(buildCommand('status'));
    } catch (error) {
      // Keep the transport open so the next poll can reacquire the board, but
      // never leave a status on screen after a failed write.
      this.lastStatusAt = null;
      this.#invalidateStatus();
      this._emit('error', error);
    }
  }

  #checkStatusFreshness() {
    if (!this.port || this.stopping || this.lastStatusAt === null) return;
    if (this.clock.now() - this.lastStatusAt < STATUS_STALE_AFTER_MS) return;
    this.lastStatusAt = null;
    this.#invalidateStatus();
  }

  #invalidateStatus() {
    const snapshot = this.store.snapshot();
    if (snapshot.connected || snapshot.status !== null) this.store.markDisconnected();
  }

  async #readLoop(port) {
    let reader;
    try {
      reader = port.readable.getReader();
      this.reader = reader;
      while (!this.stopping && this.port === port) {
        const { value, done } = await reader.read();
        if (done) break;
        this._consumeChunk(value);
      }
      this._flushLines();
    } catch (error) {
      if (!this.stopping) this._emit('error', error);
    } finally {
      if (reader) reader.releaseLock();
      this.reader = null;
      if (!this.stopping && this.port === port) {
        this._emit('error', new Error('シリアル接続が閉じられました'));
        await this.#handleUnexpectedDisconnect(port);
        this._emit('disconnected', this.store.snapshot());
      }
    }
  }
}

/**
 * Web Bluetooth adapter for the Hub's newline-based GATT configuration
 * service. It shares line parsing and state updates with SerialClient, and
 * waits for each response before writing the next command.
 */
export class BluetoothClient extends LineProtocolClient {
  constructor({
    bluetooth = globalThis.navigator?.bluetooth,
    store = new DeviceStateStore(),
    clock = undefined,
    pollIntervalMs = BLUETOOTH_STATUS_POLL_INTERVAL_MS,
    staleAfterMs = BLUETOOTH_STATUS_STALE_AFTER_MS,
    commandTimeoutMs = BLUETOOTH_COMMAND_TIMEOUT_MS,
  } = {}) {
    super({ store, clock });
    this.bluetooth = bluetooth;
    this.pollIntervalMs = pollIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.device = null;
    this.server = null;
    this.rx = null;
    this.tx = null;
    this.writer = null;
    this.notificationHandler = null;
    this.disconnectHandler = null;
    this.pendingResponse = null;
    this.commandTail = Promise.resolve();
    this.pollTimer = null;
    this.statusWatchdogTimer = null;
    this.stopping = false;

    this.on('response', (response) => {
      const pending = this.pendingResponse;
      if (!pending) return;
      this.pendingResponse = null;
      this.clock.clearTimeout(pending.timer);
      pending.resolve(response);
    });
  }

  get supported() {
    return typeof this.bluetooth?.requestDevice === 'function';
  }

  async connect() {
    if (this.device?.gatt?.connected && this.rx && this.tx) return this.store.snapshot();
    if (!this.supported) throw new Error('このブラウザでは Web Bluetooth を利用できません');
    if (this.device) await this.disconnect();
    this.stopping = false;
    this.parser = new LineParser();

    let permitted = [];
    if (typeof this.bluetooth.getDevices === 'function') {
      try {
        permitted = await this.bluetooth.getDevices();
      } catch {
        // A denied or unavailable saved-device list falls back to the chooser.
      }
    }
    for (const device of permitted) {
      if (!device.name?.startsWith(BLUETOOTH_NAME_PREFIX)) continue;
      try {
        await this.#open(device);
        return this.store.snapshot();
      } catch {
        // A stale permission entry or failed reconnect falls back to a chooser.
      }
    }

    const device = await this.bluetooth.requestDevice({
      filters: [{ services: [BLE_CONFIG_SERVICE_UUID] }],
    });
    await this.#open(device);
    return this.store.snapshot();
  }

  send(command) {
    const run = this.commandTail.catch(() => undefined).then(async () => {
      if (!this.#isConnected()) throw new Error('Bluetooth is not connected');
      this.#clearPollTimer();
      try {
        const response = await this.#sendOne(command);
        if (command !== 'status') await this.#sendOne('status');
        this.#scheduleStatusPoll();
        return response;
      } catch (error) {
        if (!this.stopping) this.#scheduleStatusPoll();
        throw error;
      }
    });
    this.commandTail = run.catch(() => undefined);
    return run;
  }

  refreshStatus() {
    return this.send('status');
  }

  async disconnect() {
    if (!this.device) {
      this.#clearTimers();
      this.lastStatusAt = null;
      this.store.markDisconnected();
      return;
    }
    await this.#teardown(this.device, { closeGatt: true, emit: true });
  }

  async #open(device) {
    this.device = device;
    this.stopping = false;
    this.disconnectHandler = () => {
      void this.#teardown(device, { closeGatt: false, emit: true });
    };
    device.addEventListener('gattserverdisconnected', this.disconnectHandler);
    let timeoutTimer;
    const timeout = new Promise((resolve, reject) => {
      timeoutTimer = this.clock.setTimeout(
        () => reject(new Error(BLUETOOTH_CONNECT_TIMEOUT_MESSAGE)),
        BLUETOOTH_CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.#completeOpen(device), timeout]);
    } catch (error) {
      await this.#teardown(device, { closeGatt: true, emit: false });
      throw error;
    } finally {
      this.clock.clearTimeout(timeoutTimer);
    }
  }

  async #completeOpen(device) {
    if (!device.gatt) throw new Error('Bluetooth device has no GATT server');
    this.server = await device.gatt.connect();
    this.#assertOpening(device);
    const service = await this.server.getPrimaryService(BLE_CONFIG_SERVICE_UUID);
    this.#assertOpening(device);
    const rx = await service.getCharacteristic(BLE_CONFIG_RX_UUID);
    this.#assertOpening(device);
    const tx = await service.getCharacteristic(BLE_CONFIG_TX_UUID);
    this.#assertOpening(device);
    if (typeof rx.writeValueWithResponse !== 'function') {
      throw new Error('Bluetooth RX does not support acknowledged writes');
    }
    if (typeof tx.startNotifications !== 'function' || typeof tx.addEventListener !== 'function') {
      throw new Error('Bluetooth TX notifications are unavailable');
    }
    this.rx = rx;
    this.tx = tx;
    this.notificationHandler = (event) => {
      const value = event.target?.value ?? event.value;
      if (!value || !ArrayBuffer.isView(value)) return;
      this._consumeChunk(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    };
    tx.addEventListener('characteristicvaluechanged', this.notificationHandler);
    await tx.startNotifications();
    this.#assertOpening(device);
    this.writer = new SerialCommandWriter({
      write: (bytes) => rx.writeValueWithResponse(bytes),
    });
    this.store.markConnected();
    this.lastStatusAt = this.clock.now();
    this._emit('connected', this.store.snapshot());
    this.statusWatchdogTimer = this.clock.setInterval(
      () => this.#checkStatusFreshness(),
      STATUS_WATCHDOG_INTERVAL_MS,
    );
    await this.send('status');
  }

  #assertOpening(device) {
    if (this.device === device && !this.stopping) return;
    if (device.gatt?.connected) device.gatt.disconnect();
    throw new Error('Bluetooth connection closed');
  }

  #sendOne(command) {
    if (!this.#isConnected() || !this.writer) {
      return Promise.reject(new Error('Bluetooth is not connected'));
    }
    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const pending = {
      resolve: resolveResponse,
      reject: rejectResponse,
      timer: null,
    };
    pending.timer = this.clock.setTimeout(() => {
      if (this.pendingResponse !== pending) return;
      this.pendingResponse = null;
      const error = new Error('Bluetooth response timed out');
      pending.reject(error);
      this._emit('error', error);
      void this.#teardown(this.device, { closeGatt: true, emit: true });
    }, this.commandTimeoutMs);
    this.pendingResponse = pending;

    return (async () => {
      try {
        await this.writer.send(command);
        return await responsePromise;
      } catch (error) {
        if (this.pendingResponse === pending) {
          this.pendingResponse = null;
          this.clock.clearTimeout(pending.timer);
        }
        throw error;
      }
    })();
  }

  #isConnected() {
    return Boolean(!this.stopping && this.device?.gatt?.connected && this.writer);
  }

  #scheduleStatusPoll() {
    this.#clearPollTimer();
    if (!this.#isConnected()) return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      this.send('status').catch((error) => {
        if (this.stopping) return;
        this._emit('error', error);
        this.#scheduleStatusPoll();
      });
    }, this.pollIntervalMs);
  }

  #clearPollTimer() {
    if (this.pollTimer === null) return;
    this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  #clearTimers() {
    this.#clearPollTimer();
    if (this.statusWatchdogTimer !== null) {
      this.clock.clearInterval(this.statusWatchdogTimer);
      this.statusWatchdogTimer = null;
    }
  }

  #checkStatusFreshness() {
    if (!this.#isConnected() || this.lastStatusAt === null) return;
    if (this.clock.now() - this.lastStatusAt < this.staleAfterMs) return;
    this.lastStatusAt = null;
    this.store.clearStatus();
  }

  async #teardown(device, { closeGatt, emit }) {
    if (device !== this.device) return;
    this.stopping = true;
    this.#clearTimers();
    this.lastStatusAt = null;
    if (this.pendingResponse) {
      const pending = this.pendingResponse;
      this.pendingResponse = null;
      this.clock.clearTimeout(pending.timer);
      pending.reject(new Error('Bluetooth connection closed'));
    }
    if (this.tx && this.notificationHandler) {
      this.tx.removeEventListener?.('characteristicvaluechanged', this.notificationHandler);
    }
    device.removeEventListener?.('gattserverdisconnected', this.disconnectHandler);
    const writer = this.writer;
    this.writer = null;
    this.notificationHandler = null;
    this.disconnectHandler = null;
    this.server = null;
    this.rx = null;
    this.tx = null;
    this.device = null;
    if (writer) await writer.close().catch(() => undefined);
    if (closeGatt && device.gatt?.connected) device.gatt.disconnect();
    this.store.markDisconnected();
    if (emit) this._emit('disconnected', this.store.snapshot());
  }
}
