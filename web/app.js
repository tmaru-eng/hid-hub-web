import {
  classifyResult,
  DeviceStateStore,
  describeError,
  describeOperation,
  describeResult,
  describeUiState,
  INPUT_KEYS,
  LAYOUTS,
  HOST_OS,
  BUTTON_ORDER_PRESETS,
  buttonOrderChoices,
  PC_COUNT,
  SWITCH_KEYS,
  switchKeysProblem,
  buttonOrderLabel,
  configurationFieldPolicy,
  rgbAt,
  BluetoothClient,
  SerialClient,
  buildCommand,
} from './protocol.js';

const INPUT_LABELS = Object.freeze({ k1: 'キーボード1', k2: 'キーボード2', m1: 'マウス1', m2: 'マウス2' });
const INPUT_TYPES = Object.freeze({ k1: 'kbd', k2: 'kbd', m1: 'mouse', m2: 'mouse' });
const LED_PREVIEWS = Object.freeze({
  pc1: { name: 'PC1', detail: '赤・選択中のPC' },
  pc2: { name: 'PC2', detail: '緑・選択中のPC' },
  pc3: { name: 'PC3', detail: '青・選択中のPC' },
  'select-slot': { name: '入力枠を選択中', detail: '水色で呼吸' },
  pairing: { name: '登録中', detail: 'キーボードは黄、マウスは紫。1番は1回・2番は2回の短点滅に続く長点灯' },
  confirm: { name: '入れ替え確認', detail: '対象の表示に続いて白く長点灯' },
  success: { name: '登録成功', detail: '白を600ms点灯して通常表示へ' },
  failure: { name: '失敗・時間切れ', detail: '白を100msずつ3回点滅' },
  cancel: { name: '確認時間切れ', detail: '200ms消灯して通常表示へ' },
  idle: { name: '本体未接続', detail: '本体の状態を取得できません' },
});

const $ = (id) => document.getElementById(id);
const store = new DeviceStateStore();
const bluetoothClient = new BluetoothClient({ store });
const usbClient = new SerialClient({ store });
let mode = 'disconnected';
let transport = null;
let activeClient = null;
let pendingDestructive = null;
let busy = false;
let lastResponse = null;
let activeLedPatternKey = null;
let activeLedState = null;
let ledEpoch = 0;

function currentStatus() {
  return store.snapshot().status;
}

function isLive() {
  return mode === 'live' && store.snapshot().connected && currentStatus() !== null;
}

function canSend() {
  return isLive() && !busy;
}

function canChangeRegistration() {
  return canSend() && transport !== 'bluetooth';
}

function bluetoothUnavailableMessage() {
  if (!window.isSecureContext) return 'Bluetooth接続には HTTPS または localhost が必要です。';
  if (!bluetoothClient.supported) return 'このブラウザは Web Bluetooth に対応していません。';
  return '';
}

function formatConnectionInterval(intervalUs) {
  if (!Number.isSafeInteger(intervalUs) || intervalUs < 0) return null;
  const milliseconds = intervalUs / 1000;
  const value = Number.isInteger(milliseconds)
    ? String(milliseconds)
    : milliseconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `通信間隔 ${value} ms`;
}

function formatTarget(target) {
  if (!target) return '—';
  if (/^pc[1-3]$/.test(target)) return `PC${target.slice(-1)}`;
  return INPUT_LABELS[target] ?? target;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = Math.ceil(ms / 1000);
  return `残り ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function deviceName(entry, fallback) {
  if (entry?.name !== null && typeof entry?.name === 'string' && entry.name.trim() !== '') return entry.name;
  return entry?.registered ? '名前未取得' : fallback;
}

function makeButton(label, className, { disabled = false, hidden = false, title = '', ariaLabel = '', onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${className}`.trim();
  button.textContent = label;
  button.disabled = disabled;
  button.hidden = hidden;
  if (title) button.title = title;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function addStatusChip(parent, text, className = 'unknown') {
  const chip = document.createElement('span');
  chip.className = `status-chip ${className}`;
  chip.textContent = text;
  parent.append(chip);
}

function unknownStatusCard(label, kind, detail = '本体の状態を取得できません') {
  const card = document.createElement('article');
  card.className = 'device-card unknown-card';
  card.dataset.disabled = 'true';
  const accent = document.createElement('div');
  accent.className = `card-accent ${kind}`;
  card.append(accent);
  const top = document.createElement('div');
  top.className = 'card-top';
  const titleBox = document.createElement('div');
  const overline = document.createElement('div');
  overline.className = 'card-label';
  overline.textContent = kind.startsWith('pc') ? 'OUTPUT' : 'INPUT SLOT';
  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = label;
  titleBox.append(overline, title);
  top.append(titleBox);
  card.append(top);
  const name = document.createElement('p');
  name.className = 'device-name unknown';
  name.textContent = detail;
  card.append(name);
  const rows = document.createElement('div');
  rows.className = 'status-row';
  addStatusChip(rows, '状態不明');
  card.append(rows);
  return card;
}

function renderConnection() {
  const pill = $('connectionPill');
  const label = $('connectionLabel');
  const connected = mode === 'live';
  const bluetoothUnavailable = bluetoothUnavailableMessage();
  const usbSupported = typeof navigator.serial?.requestPort === 'function';
  pill.dataset.state = connected ? 'connected' : 'disconnected';
  label.textContent = connected
    ? transport === 'bluetooth' ? 'Bluetooth接続中' : 'USBシリアル接続中'
    : '設定画面未接続';
  $('connectButton').disabled = connected || busy || Boolean(bluetoothUnavailable);
  $('connectButton').textContent = 'Bluetooth で接続';
  $('connectButton').title = bluetoothUnavailable;
  $('bluetoothSupport').hidden = !bluetoothUnavailable;
  $('bluetoothSupport').textContent = bluetoothUnavailable
    ? `${bluetoothUnavailable} ${usbSupported ? 'USBで接続する場合は下のボタンを使ってください。' : 'このブラウザではUSB Web Serialも利用できません。'}`
    : '';
  $('usbConnectButton').disabled = connected || busy || !usbSupported;
  $('usbConnectButton').title = usbSupported ? '' : 'このブラウザは Web Serial に対応していません。';
  $('disconnectButton').disabled = !connected || busy;
  $('footerTransport').textContent = connected
    ? `設定画面 · ${transport === 'bluetooth' ? 'Bluetooth' : 'USB'}`
    : 'Bluetooth接続を優先 · USB接続も利用可能';
}

function renderNotice() {
  const notice = $('modeNotice');
  const title = $('modeTitle');
  const description = $('modeDescription');
  notice.dataset.mode = mode;
  if (mode === 'live') {
    title.textContent = currentStatus() ? '本体に接続しています' : '本体に接続済み・状態を待っています';
    if (transport === 'bluetooth') {
      description.textContent = currentStatus()
        ? 'Bluetooth接続中は登録・入れ替え・登録解除・全消去を使えません。USB で接続するか、本体のボタンで操作してください。PC切り替えと設定は使えます。'
        : 'Bluetooth接続を確立しました。状態が届くまで操作を無効にしています。';
    } else {
      description.textContent = currentStatus()
        ? '表示中の登録・接続・操作状態は、本体から受け取った最新の情報です。'
        : 'UART USBで本体に接続済みです。状態が届くまで操作を無効にしています。';
    }
  } else {
    title.textContent = '設定画面と本体が未接続';
    const bluetoothUnavailable = bluetoothUnavailableMessage();
    const usbSupported = typeof navigator.serial?.requestPort === 'function';
    description.textContent = bluetoothUnavailable
      ? `${bluetoothUnavailable} ${usbSupported ? 'Bluetoothに対応したブラウザで開くか、USBで接続してください。' : 'Bluetoothに対応したブラウザでHTTPSまたはlocalhostから開いてください。'}`
      : '「Bluetooth で接続」を押して本体を選んでください。USBで接続する場合は「USBで接続」を使ってください。';
  }
}

function renderOperation() {
  const status = currentStatus();
  const badge = $('operationStateBadge');
  const title = $('operationTitle');
  const detail = $('operationDetail');
  const remaining = $('remainingTime');
  const cancel = $('cancelButton');
  const result = $('resultMessage');
  badge.removeAttribute('data-state');
  remaining.textContent = '';
  cancel.hidden = true;
  result.hidden = true;
  if (!status) {
    badge.textContent = '状態不明';
    title.textContent = '本体の状態を取得できません';
    detail.textContent = '本体の状態が届くまで、画面側では状態を推測しません。';
    if (lastResponse) {
      result.hidden = false;
      result.dataset.kind = lastResponse.ok ? 'ok' : 'error';
      result.textContent = lastResponse.ok ? '本体が操作を受け付けました。' : describeError(lastResponse.error);
    }
    return;
  }
  const ui = status.ui;
  badge.textContent = describeUiState(ui.state);
  badge.dataset.state = ui.state;
  if (ui.state === 'normal') {
    title.textContent = `通常表示 · 選択中 ${formatTarget(`pc${status.selectedPc}`)}`;
    detail.textContent = 'PCの短押しは出力先を選択し、入力はそのPCへまとめて送られます。';
  } else if (ui.state === 'select-slot') {
    title.textContent = '入力枠を選択中';
    detail.textContent = 'MODEを離し、PC1・PC2・PC3・MODEのボタンでK1・K2・M1・M2を選んでください。登録済みの枠は確認なしで入れ替えます。';
    if (ui.remainingMs > 0) remaining.textContent = formatDuration(ui.remainingMs);
    cancel.hidden = false;
  } else if (ui.state === 'confirm') {
    title.textContent = `${describeUiState(ui.state)} · ${formatTarget(ui.target)}`;
    detail.textContent = '別機器への入れ替えは新しい登録の保存後に反映します。中止・失敗・時間切れ・bond保存満杯では前の登録が残ります。同じ機器の鍵交換後は新しい鍵を使います。';
    if (ui.remainingMs > 0) remaining.textContent = formatDuration(ui.remainingMs);
    cancel.hidden = false;
  } else {
    title.textContent = `${describeUiState(ui.state)} · ${formatTarget(ui.target)}`;
    detail.textContent = `${ui.operation ? `操作: ${describeOperation(ui.operation)}` : '本体が処理中です'}。完了・失敗は本体からの結果を待ちます。`;
    if (ui.remainingMs > 0) remaining.textContent = formatDuration(ui.remainingMs);
    cancel.hidden = false;
  }
  if (ui.result) {
    result.hidden = false;
    result.textContent = `本体からの結果: ${describeResult(ui.result)}`;
    const resultKind = classifyResult(ui.result);
    result.dataset.kind = resultKind === 'failure' ? 'error' : resultKind === 'cancelled' ? 'neutral' : 'ok';
  } else if (lastResponse) {
    result.hidden = false;
    result.dataset.kind = lastResponse.ok ? 'ok' : 'error';
    result.textContent = lastResponse.ok ? '本体が操作を受け付けました。' : describeError(lastResponse.error);
  }
}

function renderPcCards() {
  const root = $('pcCards');
  root.replaceChildren();
  const status = currentStatus();
  for (let index = 0; index < 3; index += 1) {
    const pcNumber = index + 1;
    const key = `pc${pcNumber}`;
    if (!status) {
      root.append(unknownStatusCard(`PC${pcNumber}`, key));
      continue;
    }
    const entry = status.pcs[index];
    const selected = status.selectedPc === pcNumber;
    const card = document.createElement('article');
    card.className = 'device-card';
    card.dataset.selected = String(selected);
    card.dataset.disabled = String(mode !== 'live');
    const accent = document.createElement('div');
    accent.className = `card-accent ${key}`;
    card.append(accent);
    const top = document.createElement('div');
    top.className = 'card-top';
    const titleBox = document.createElement('div');
    const overline = document.createElement('div');
    overline.className = 'card-label';
    overline.textContent = 'OUTPUT';
    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = `PC${pcNumber}`;
    titleBox.append(overline, title);
    top.append(titleBox);
    const mark = document.createElement('span');
    mark.className = 'selection-mark';
    mark.textContent = '選択中';
    mark.hidden = !selected;
    top.append(mark);
    card.append(top);
    const name = document.createElement('p');
    name.className = `device-name${entry.name === null ? ' unknown' : ''}`;
    name.textContent = deviceName(entry, '未登録');
    card.append(name);
    const rows = document.createElement('div');
    rows.className = 'status-row';
    addStatusChip(rows, entry.registered ? '登録済み' : '未登録', entry.registered ? 'registered' : 'unknown');
    addStatusChip(rows, entry.connected ? 'BLE接続中' : entry.registered ? 'BLE未接続' : 'BLE状態—', entry.connected ? 'connected' : 'unknown');
    if (entry.connected) addStatusChip(rows, formatConnectionInterval(entry.intervalUs) ?? '通信間隔 —');
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const disabled = !canSend();
    const registrationDisabled = !canChangeRegistration();
    actions.append(makeButton(selected ? '選択中' : '出力先に選択', 'button-soft', {
      disabled: disabled || selected,
      ariaLabel: `PC${pcNumber}${selected ? 'は選択中' : 'を出力先に選択'}`,
      onClick: () => sendCommand(buildCommand('select', pcNumber), `PC${pcNumber}を選択`),
    }));
    if (entry.registered) {
      actions.append(makeButton('入れ替え', 'button-ghost', {
        disabled: registrationDisabled,
        title: '別PCへの入れ替えは新しい登録の保存後に反映します。中止・失敗・時間切れ・bond保存満杯では現在の登録が残ります。同じPCの鍵交換後は新しい鍵を使います。',
        ariaLabel: `PC${pcNumber}を入れ替え`,
        onClick: () => sendCommand(buildCommand('replace', 'pc', pcNumber), `PC${pcNumber}の入れ替え確認`, { requiresUsb: true }),
      }));
      actions.append(makeButton('登録解除', 'button-danger-outline', {
        disabled: registrationDisabled,
        ariaLabel: `PC${pcNumber}の登録を解除`,
        onClick: () => openDestructive(`PC${pcNumber}の登録を解除しますか？`, '現在のPC登録だけを解除します。入力枠や他のPCは変更しません。', buildCommand('forget', 'pc', pcNumber)),
      }));
    } else {
      actions.append(makeButton('登録する', 'button-ghost', {
        disabled: registrationDisabled,
        ariaLabel: `PC${pcNumber}を登録`,
        onClick: () => sendCommand(buildCommand('pair', 'pc', pcNumber), `PC${pcNumber}の登録`, { requiresUsb: true }),
      }));
    }
    card.append(actions);
    root.append(card);
  }
}

function renderInputCards() {
  const root = $('inputCards');
  root.replaceChildren();
  const status = currentStatus();
  for (const key of INPUT_KEYS) {
    const index = INPUT_KEYS.indexOf(key);
    const label = INPUT_LABELS[key];
    if (!status) {
      root.append(unknownStatusCard(`${key.toUpperCase()} · ${label}`, INPUT_TYPES[key], '本体の状態を取得できません'));
      continue;
    }
    const entry = status.inputs[index];
    const card = document.createElement('article');
    card.className = 'device-card';
    card.dataset.disabled = String(mode !== 'live');
    const accent = document.createElement('div');
    accent.className = `card-accent ${INPUT_TYPES[key]}`;
    card.append(accent);
    const top = document.createElement('div');
    top.className = 'card-top';
    const titleBox = document.createElement('div');
    const overline = document.createElement('div');
    overline.className = 'card-label';
    overline.textContent = 'INPUT SLOT';
    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = `${key.toUpperCase()} · ${label}`;
    titleBox.append(overline, title);
    top.append(titleBox);
    card.append(top);
    const name = document.createElement('p');
    name.className = `device-name${entry.name === null ? ' unknown' : ''}`;
    name.textContent = deviceName(entry, '未登録');
    card.append(name);
    const rows = document.createElement('div');
    rows.className = 'status-row';
    addStatusChip(rows, entry.registered ? '登録済み' : '未登録', entry.registered ? 'registered' : 'unknown');
    addStatusChip(rows, entry.connected ? 'BLE接続中' : entry.registered ? 'BLE未接続' : 'BLE状態—', entry.connected ? 'connected' : 'unknown');
    if (entry.connected) addStatusChip(rows, formatConnectionInterval(entry.intervalUs) ?? '通信間隔 —');
    addStatusChip(rows, entry.slot === null ? '物理枠 未割当' : `物理枠 ${entry.slot}`, entry.slot === null ? 'unknown' : 'connected');
    if (entry.intervalPolicyGaveUp) addStatusChip(rows, '30 ms 要求を終了', 'unknown');
    if ((entry.peerIntervalRejections ?? 0) > 0) addStatusChip(rows, `短い間隔要求を拒否 ${entry.peerIntervalRejections} 回`, 'unknown');
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const registrationDisabled = !canChangeRegistration();
    if (entry.registered) {
      actions.append(makeButton('入れ替え', 'button-ghost', {
        disabled: registrationDisabled,
        title: '別機器への入れ替えは新しい登録の保存後に反映します。中止・失敗・時間切れ・bond保存満杯では現在の登録が残ります。同じ機器の鍵交換後は新しい鍵を使います。',
        ariaLabel: `${label}を入れ替え`,
        onClick: () => sendCommand(buildCommand('replace', 'input', key), `${label}の入れ替え確認`, { requiresUsb: true }),
      }));
      actions.append(makeButton('登録解除', 'button-danger-outline', {
        disabled: registrationDisabled,
        ariaLabel: `${label}の登録を解除`,
        onClick: () => openDestructive(`${label}の登録を解除しますか？`, 'この入力枠だけを解除します。他の入力枠やPC登録は変更しません。', buildCommand('forget', 'input', key)),
      }));
    } else {
      actions.append(makeButton('登録する', 'button-ghost', {
        disabled: registrationDisabled,
        ariaLabel: `${label}を登録`,
        onClick: () => sendCommand(buildCommand('pair', 'input', key), `${label}の登録`, { requiresUsb: true }),
      }));
    }
    card.append(actions);
    const footnote = document.createElement('p');
    footnote.className = 'card-footnote';
    footnote.textContent = entry.name === null && entry.registered ? '名前未取得' : '入力枠はPCの出力先選択とは独立しています。';
    card.append(footnote);
    root.append(card);
  }
}

const configControls = new Map();
const configInputTitles = new Map();
const CONFIG_LABELS = Object.freeze({ us: 'US', jis: 'JIS', unspecified: '未指定', windows: 'Windows', macos: 'macOS', linux: 'Linux' });

function makeConfigField(parent, scope, slot, field, label, choices) {
  const key = `${scope}-${slot}-${field}`;
  const row = document.createElement('div');
  row.className = 'config-field';
  const caption = document.createElement('label');
  caption.htmlFor = `config-${key}`;
  caption.textContent = label;
  const select = document.createElement('select');
  select.id = caption.htmlFor;
  const controlLabel = scope === 'buttons' ? label : `${scope === 'pc' ? 'PC' : '物理枠'}${slot}の${label}`;
  select.setAttribute('aria-label', controlLabel);
  for (const value of choices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = scope === 'buttons' ? buttonOrderLabel(value) : CONFIG_LABELS[value];
    select.append(option);
  }
  const current = document.createElement('span');
  current.className = 'config-current';
  const control = { scope, slot, field, select, checkbox: null, current, saved: null, dirty: false, button: null };
  const button = makeButton('保存', 'button-soft', {
    ariaLabel: `${controlLabel}を保存`,
    onClick: () => sendCommand(scope === 'buttons' ? buildCommand('set-buttons', select.value) : buildCommand('set', scope, slot, field, select.value), `${label}を保存`),
  });
  control.button = button;
  select.addEventListener('change', () => { control.dirty = select.value !== control.saved; renderConfiguration(); });
  configControls.set(key, control);
  row.append(caption, select, button, current);
  parent.append(row);
}

function makeConfigToggle(parent, slot, label) {
  const field = 'mac-delete-swap';
  const row = document.createElement('div');
  row.className = 'config-field config-toggle-field';
  const caption = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.id = `config-input-${slot}-${field}`;
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', `物理枠${slot}の${label}`);
  caption.htmlFor = checkbox.id;
  caption.append(checkbox, document.createTextNode(label));
  const current = document.createElement('span');
  current.className = 'config-current';
  const control = { scope: 'input', slot, field, select: null, checkbox, current, saved: null, dirty: false, button: null };
  const button = makeButton('保存', 'button-soft', {
    ariaLabel: `物理枠${slot}のMac DeleteとBack Space設定を保存`,
    onClick: () => sendCommand(
      buildCommand('set', 'input', slot, field, checkbox.checked ? 'on' : 'off'),
      `物理枠${slot}のDeleteとBack Space設定を保存`,
    ),
  });
  control.button = button;
  checkbox.addEventListener('change', () => { control.dirty = checkbox.checked !== control.saved; renderConfiguration(); });
  configControls.set(`input-${slot}-${field}`, control);
  row.append(caption, button, current);
  parent.append(row);
}

const shortcutKeySelects = [];
let shortcutKeyDirty = false;
const shortcutKeyUi = {};

function initShortcutKeys() {
  const panel = document.createElement('article');
  panel.className = 'panel config-card';
  const note = document.createElement('p');
  note.className = 'config-note';
  note.textContent = 'Ctrl + Alt + Shift を押しながらキーを押すとPCが切り替わります。初期設定は 1・2・3 で、ここでPCごとに好きなキー（例: A・S・D）へ変えられます。';
  panel.append(note);
  for (let slot = 1; slot <= PC_COUNT; slot += 1) {
    const row = document.createElement('div');
    row.className = 'config-field';
    const caption = document.createElement('label');
    caption.htmlFor = `config-shortcut-key-${slot}`;
    caption.textContent = `PC${slot}へ切り替えるキー`;
    const select = document.createElement('select');
    select.id = caption.htmlFor;
    select.setAttribute('aria-label', `PC${slot}へ切り替えるキー`);
    for (const key of SWITCH_KEYS) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key.toUpperCase();
      select.append(option);
    }
    select.addEventListener('change', () => { shortcutKeyDirty = true; renderShortcutKeys(); });
    shortcutKeySelects.push(select);
    row.append(caption, select);
    panel.append(row);
  }
  const problem = document.createElement('p');
  problem.className = 'config-current';
  const current = document.createElement('p');
  current.className = 'config-current';
  const button = makeButton('保存', 'button-soft', {
    ariaLabel: 'PC切り替えキーを保存',
    onClick: () => sendCommand(
      buildCommand('set-shortcut-keys', shortcutKeySelects.map((select) => select.value)),
      'PC切り替えキーを保存',
    ),
  });
  const reset = makeButton('初期設定（1・2・3）に戻す', 'button-soft', {
    ariaLabel: 'PC切り替えキーを初期設定の1・2・3に戻す',
    onClick: () => sendCommand(buildCommand('set-shortcut-default'), 'PC切り替えキーを初期設定に戻す'),
  });
  Object.assign(shortcutKeyUi, { problem, current, button, reset });
  panel.append(problem, button, reset, current);
  $('shortcutConfig').append(panel);
}

function renderShortcutKeys() {
  const status = currentStatus();
  const config = status?.config;
  const supported = Boolean(config && config.shortcutKeys !== undefined);
  const saved = supported && config.shortcutKeys.length === PC_COUNT ? config.shortcutKeys : null;
  if (!shortcutKeyDirty) {
    // Show the saved keys, or the default A/S/D proposal when the hub uses another chord.
    (saved ?? ['a', 's', 'd']).forEach((key, index) => { shortcutKeySelects[index].value = key; });
  }
  const keys = shortcutKeySelects.map((select) => select.value);
  const problem = switchKeysProblem(keys);
  const same = saved && saved.every((key, index) => key === keys[index]);
  if (same) shortcutKeyDirty = false;
  shortcutKeyUi.problem.textContent = problem ?? '';
  shortcutKeyUi.current.textContent = !supported
    ? 'このファームはPC切り替えキーの設定に未対応です。ファームウェアを更新してください。'
    : saved
      ? `本体の保存値: ${saved.map((key, index) => `PC${index + 1}=${key.toUpperCase()}`).join(' ')}${same ? '' : ' · 未保存の変更あり'}`
      : config.shortcut === 'ctrl-alt-shift-digits'
        ? '本体の保存値: 初期設定（Ctrl+Alt+Shift+1・2・3）'
        : config.shortcut === 'off'
          ? '本体の保存値: キーボードでの切り替えなし'
          : `本体の保存値: ${config.shortcut}`;
  const disabled = !canSend() || !supported || status.ui.state !== 'normal';
  shortcutKeySelects.forEach((select) => { select.disabled = disabled; });
  shortcutKeyUi.button.disabled = disabled || Boolean(problem) || Boolean(same);
  shortcutKeyUi.reset.disabled = disabled || (supported && config.shortcut === 'ctrl-alt-shift-digits');
}

function initConfiguration() {
  initShortcutKeys();
  const buttonPanel = document.createElement('article');
  buttonPanel.className = 'panel config-card';
  makeConfigField(buttonPanel, 'buttons', 0, 'order', 'ボタンの並び', BUTTON_ORDER_PRESETS);
  $('buttonConfig').append(buttonPanel);
  for (let slot = 1; slot <= 3; slot += 1) {
    const panel = document.createElement('article');
    panel.className = 'panel config-card';
    const title = document.createElement('h3');
    title.textContent = `PC${slot}`;
    panel.append(title);
    makeConfigField(panel, 'pc', slot, 'layout', 'PC側の配列', LAYOUTS);
    makeConfigField(panel, 'pc', slot, 'os', '接続先OS', HOST_OS);
    $('pcConfig').append(panel);
  }
  for (let slot = 1; slot <= 4; slot += 1) {
    const panel = document.createElement('article');
    panel.className = 'panel config-card';
    const title = document.createElement('h3');
    configInputTitles.set(slot, title);
    panel.append(title);
    makeConfigField(panel, 'input', slot, 'layout', '入力配列', LAYOUTS);
    makeConfigToggle(panel, slot, 'Mac へ送るとき Delete と Back Space を入れ替える（HHKB の HHK モード向け。Fn+` も Back Space になります）');
    $('inputConfig').append(panel);
  }
}

function renderConfiguration() {
  renderShortcutKeys();
  const status = currentStatus();
  const config = status?.config;
  $('configAvailability').textContent = !status ? '設定を取得できません。' : !config ? 'このファームは設定の読み出しに未対応です。' : '保存後、本体から届く設定値を確認します。';
  for (const [slot, title] of configInputTitles) {
    const role = status?.inputs.find((entry) => entry.slot === slot);
    const legacy = status?.legacyInputs.some((entry) => entry.slot === slot);
    title.textContent = `物理枠${slot} · ${role ? INPUT_LABELS[role.id] : legacy ? '割当待ち' : '未割当'}`;
  }
  for (const control of configControls.values()) {
    const macDeleteSwapUnsupported = Boolean(
      control.checkbox && config && !config.inputMacDeleteSwapSupported,
    );
    const values = control.checkbox
      ? (macDeleteSwapUnsupported ? undefined : config?.inputMacDeleteSwap)
      : control.scope === 'input' ? config?.inputLayouts : control.field === 'os' ? config?.outputOs : config?.outputLayouts;
    const saved = macDeleteSwapUnsupported
      ? null
      : control.scope === 'buttons' ? config?.buttonOrder ?? null : values?.[control.slot - 1] ?? null;
    if (control.scope === 'buttons') {
      const custom = control.select.querySelector('[data-custom-order]');
      const customValue = buttonOrderChoices(saved)[2] ?? null;
      if (custom && custom.value !== customValue) custom.remove();
      if (customValue && !control.select.querySelector('[data-custom-order]')) {
        const option = document.createElement('option');
        option.dataset.customOrder = '';
        option.value = customValue;
        option.textContent = buttonOrderLabel(customValue);
        control.select.append(option);
      }
    }
    const currentValue = control.checkbox ? control.checkbox.checked : control.select.value;
    if (saved === null) {
      control.dirty = false;
      if (control.checkbox) control.checkbox.checked = false;
      else control.select.selectedIndex = -1;
    } else if (!control.dirty || currentValue === saved) {
      if (control.checkbox) control.checkbox.checked = saved;
      else control.select.value = saved;
      control.dirty = false;
    }
    control.saved = saved;
    const savedLabel = control.checkbox ? (saved ? 'オン' : 'オフ') : control.scope === 'buttons' ? buttonOrderLabel(saved) : CONFIG_LABELS[saved];
    const policy = configurationFieldPolicy(control.scope, transport);
    const guidance = macDeleteSwapUnsupported
      ? 'このファームはこの設定に未対応です。ファームウェアを更新してください。'
      : policy.guidance;
    const savedText = saved === null ? '保存値は不明' : `本体の保存値: ${savedLabel}${control.dirty ? ' · 未保存の変更あり' : ''}`;
    control.current.textContent = guidance ? `${savedText} · ${guidance}` : savedText;
    const disabled = !canSend() || !config || status.ui.state !== 'normal' || policy.disabled || macDeleteSwapUnsupported || (control.scope === 'buttons' && saved === null);
    if (control.checkbox) control.checkbox.disabled = disabled;
    else control.select.disabled = disabled;
    control.button.disabled = disabled || !control.dirty;
  }
}

function renderCandidates() {
  const section = $('candidateSection');
  const root = $('candidateCards');
  root.replaceChildren();
  const status = currentStatus();
  const ui = status?.ui;
  const showingCandidates = Boolean(status && ui?.state === 'pairing' && INPUT_KEYS.includes(ui.target));
  section.hidden = !showingCandidates;
  if (!showingCandidates) return;

  if (status.candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'candidate-empty';
    empty.textContent = '探索・接続処理を進めています。候補が表示された場合は選択できます。';
    root.append(empty);
    return;
  }

  for (const candidate of status.candidates) {
    const card = document.createElement('article');
    card.className = 'candidate-card';
    const top = document.createElement('div');
    top.className = 'candidate-top';
    const title = document.createElement('h3');
    title.textContent = `候補 ${candidate.id}`;
    const rssi = document.createElement('span');
    rssi.className = 'candidate-rssi';
    rssi.textContent = `${candidate.rssi} dBm`;
    top.append(title, rssi);
    card.append(top);
    const name = document.createElement('p');
    name.className = `candidate-name${candidate.name === null ? ' unknown' : ''}`;
    name.textContent = candidate.name === null ? '名前未取得' : candidate.name;
    card.append(name);
    const address = document.createElement('code');
    address.className = 'candidate-address';
    address.textContent = candidate.address;
    card.append(address);
    const note = document.createElement('p');
    note.className = 'candidate-note';
    note.textContent = '種類は接続して確認';
    card.append(note);
    card.append(makeButton('この候補を選択', 'button-soft', {
      disabled: !canChangeRegistration(),
      ariaLabel: `候補${candidate.id}を選択`,
      onClick: () => sendCommand(
        buildCommand('choose', 'input', status.candidateGeneration, candidate.id),
        `候補${candidate.id}を選択`,
        { requiresUsb: true },
      ),
    }));
    root.append(card);
  }
}

function renderLegacyCards() {
  const section = $('legacySection');
  const root = $('legacyCards');
  root.replaceChildren();
  const status = currentStatus();
  const entries = status?.legacyInputs ?? [];
  section.hidden = entries.length === 0;
  for (const entry of entries) {
    const card = document.createElement('article');
    card.className = 'legacy-card';
    const title = document.createElement('p');
    title.textContent = `物理スロット ${entry.slot} · 旧登録`;
    card.append(title);
    const rows = document.createElement('div');
    rows.className = 'status-row';
    addStatusChip(rows, entry.registered ? '登録済み' : '未登録', entry.registered ? 'registered' : 'unknown');
    addStatusChip(rows, entry.connected ? 'BLE接続中' : entry.registered ? 'BLE未接続' : 'BLE状態—', entry.connected ? 'connected' : 'unknown');
    if (entry.intervalPolicyGaveUp) addStatusChip(rows, '30 ms 要求を終了', 'unknown');
    if ((entry.peerIntervalRejections ?? 0) > 0) addStatusChip(rows, `短い間隔要求を拒否 ${entry.peerIntervalRejections} 回`, 'unknown');
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'legacy-actions';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `物理スロット${entry.slot}の割り当て先`);
    select.disabled = !canChangeRegistration();
    for (const key of INPUT_KEYS) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = INPUT_LABELS[key];
      select.append(option);
    }
    const assign = makeButton('この枠へ割り当て', 'button-soft', {
      disabled: !canChangeRegistration(),
      onClick: () => sendCommand(buildCommand('assign', 'input', entry.slot, select.value), `物理スロット${entry.slot}の割り当て`, { requiresUsb: true }),
    });
    actions.append(select, assign);
    card.append(actions);
    root.append(card);
  }
}

function setLed(patternKey, nextState, elapsedMs = 0) {
  const pattern = LED_PREVIEWS[patternKey] ?? LED_PREVIEWS.idle;
  const signature = `${patternKey}:${JSON.stringify(nextState)}`;
  if (signature !== `${activeLedPatternKey}:${JSON.stringify(activeLedState)}`) {
    activeLedPatternKey = patternKey;
    activeLedState = nextState;
    ledEpoch = performance.now() - (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0);
  }
  const orb = $('ledOrb');
  orb.className = 'led-orb';
  orb.setAttribute('aria-label', `${pattern.name} LEDプレビュー`);
  $('ledPatternName').textContent = pattern.name;
  $('ledPatternDetail').textContent = pattern.detail;
}

function normalLedState(status) {
  const selectedPc = status.selectedPc;
  const pc = status.pcs[selectedPc - 1];
  return {
    state: 'normal',
    selectedPc,
    registered: pc?.registered === true,
    connected: pc?.connected === true,
  };
}

function renderLed() {
  const status = currentStatus();
  $('ledSource').textContent = mode === 'live' ? '本体状態に連動' : '本体状態なし';
  if (!status) {
    setLed('idle', null);
    return;
  }
  const ui = status.ui;
  const previous = normalLedState(status);
  const resultKind = classifyResult(ui.result);
  const resultRemainingMs = Number.isFinite(ui.resultRemainingMs)
    ? ui.resultRemainingMs
    : ui.result ? 600 : 0;
  const resultActive = Boolean(ui.result) && resultRemainingMs > 0;
  if (resultActive && resultKind === 'failure') {
    setLed('failure', { state: 'failure', previous }, Math.max(0, 600 - resultRemainingMs));
  } else if (resultActive && resultKind === 'success') {
    setLed('success', { state: 'success', previous }, Math.max(0, 600 - resultRemainingMs));
  } else if (resultActive && resultKind === 'cancelled') {
    setLed('cancel', { state: 'cancel', previous }, Math.max(0, 200 - resultRemainingMs));
  } else if (ui.state === 'confirm') {
    setLed('confirm', { state: 'confirm', target: ui.target });
  } else if (ui.state === 'pairing') {
    setLed('pairing', { state: 'pairing', target: ui.target });
  } else if (ui.state === 'select-slot') {
    setLed('select-slot', { state: 'select-slot' });
  } else {
    setLed(`pc${status.selectedPc}`, previous);
  }
}

function paintLedFrame(now) {
  const rgb = rgbAt(activeLedState, Math.max(0, now - ledEpoch));
  const [red, green, blue] = rgb;
  const lit = Math.max(red, green, blue);
  const orb = $('ledOrb');
  orb.style.backgroundColor = `rgb(${red} ${green} ${blue})`;
  orb.style.opacity = lit === 0 ? '0.18' : '1';
  orb.style.boxShadow = lit === 0
    ? '0 0 0 7px rgba(113, 128, 154, .08), 0 0 0 1px rgba(255, 255, 255, .12) inset'
    : `0 0 0 7px rgba(${red}, ${green}, ${blue}, .16), 0 0 ${8 + Math.round(lit / 2)}px rgba(${red}, ${green}, ${blue}, .46), 0 0 0 1px rgba(255, 255, 255, .12) inset`;
  window.requestAnimationFrame(paintLedFrame);
}

function render() {
  $('rebootNotice').hidden = !currentStatus()?.needsReboot;
  renderConnection();
  renderNotice();
  renderOperation();
  renderPcCards();
  renderInputCards();
  renderCandidates();
  renderLegacyCards();
  renderConfiguration();
  renderLed();
  $('forgetAllButton').disabled = !canChangeRegistration();
}

function appendLog(message, kind = '') {
  const root = $('eventLog');
  root.querySelector('.log-empty')?.remove();
  const item = document.createElement('li');
  item.textContent = message;
  if (kind) item.dataset.kind = kind;
  root.append(item);
  while (root.children.length > 80) root.firstElementChild.remove();
  root.scrollTop = root.scrollHeight;
}

async function sendCommand(command, label, { requiresUsb = false } = {}) {
  if (!canSend() || (requiresUsb && transport === 'bluetooth') || !activeClient) return;
  busy = true;
  renderConnection();
  renderPcCards();
  renderInputCards();
  renderCandidates();
  renderLegacyCards();
  renderConfiguration();
  appendLog(`送信: ${command}${label ? ` · ${label}` : ''}`);
  try {
    const response = await activeClient.send(command);
    lastResponse = transport === 'bluetooth'
      ? { ok: response.ok, error: response.error }
      : { ok: true };
  } catch (error) {
    lastResponse = { ok: false, error: error.message };
    appendLog(`送信失敗: ${error.message}`, 'error');
  } finally {
    busy = false;
    render();
  }
}

function openDestructive(title, message, command) {
  if (!canChangeRegistration()) return;
  pendingDestructive = { command, label: title, requiresUsb: true };
  $('dialogTitle').textContent = title;
  $('dialogMessage').textContent = message;
  $('dialogConfirm').textContent = '解除する';
  const dialog = $('confirmDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else if (window.confirm(`${title}\n\n${message}`)) {
    const pending = pendingDestructive;
    pendingDestructive = null;
    sendCommand(pending.command, pending.label, { requiresUsb: pending.requiresUsb });
  }
}

function handleDialogSubmit(event) {
  event.preventDefault();
  const submitter = event.submitter?.value;
  const pending = pendingDestructive;
  pendingDestructive = null;
  $('confirmDialog').close();
  if (submitter === 'confirm' && pending && canChangeRegistration()) {
    sendCommand(pending.command, pending.label, { requiresUsb: pending.requiresUsb });
  }
}

function onResponse(response) {
  if (response.ok) appendLog(`応答: OK${response.error ? ` (${response.error})` : ''}`, 'ok');
  else appendLog(`応答: NG${response.error ? ` (${response.error})` : ''}`, 'error');
  lastResponse = response.ok ? { ok: true } : { ok: false, error: response.error };
  render();
}

store.subscribe(() => {
  const snapshot = store.snapshot();
  mode = snapshot.connected ? 'live' : 'disconnected';
  render();
});
function bindClient(client, kind) {
  client.on('connected', () => {
    if (activeClient !== client) return;
    mode = 'live';
    appendLog(kind === 'bluetooth' ? 'Bluetooth設定サービスに接続しました。' : 'USBシリアル接続: 115200 bps', 'ok');
    render();
  });
  client.on('disconnected', () => {
    if (activeClient === client) {
      activeClient = null;
      transport = null;
    }
    mode = store.snapshot().connected ? 'live' : 'disconnected';
    appendLog('接続が切れました。古い状態を消去しました。', 'error');
    render();
  });
  client.on('status', (status) => { appendLog(`status: PC${status.selectedPc} / UI ${status.ui.state}`); });
  client.on('response', onResponse);
  client.on('line', (event) => {
    if (event.kind === 'log') appendLog(`ログ: ${event.line}`);
    if (event.kind === 'invalid-json') appendLog(`無効なJSONを無視: ${event.line}`, 'error');
  });
  client.on('error', (error) => {
    lastResponse = { ok: false, error: error.message };
    appendLog(`通信エラー: ${error.message}`, 'error');
    render();
  });
}

bindClient(bluetoothClient, 'bluetooth');
bindClient(usbClient, 'usb');

async function connectUsing(client, kind) {
  if (busy) return;
  busy = true;
  const previous = activeClient;
  if (previous && previous !== client) await previous.disconnect().catch(() => undefined);
  activeClient = client;
  transport = kind;
  renderConnection();
  try {
    await client.connect();
    mode = 'live';
  } catch (error) {
    mode = 'disconnected';
    activeClient = null;
    transport = null;
    lastResponse = { ok: false, error: error.message };
    appendLog(`接続失敗: ${error.message}`, 'error');
  } finally {
    busy = false;
    render();
  }
}

$('connectButton').addEventListener('click', () => connectUsing(bluetoothClient, 'bluetooth'));
$('usbConnectButton').addEventListener('click', () => connectUsing(usbClient, 'usb'));

$('disconnectButton').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  renderConnection();
  try {
    await activeClient?.disconnect();
  } catch (error) {
    appendLog(`切断失敗: ${error.message}`, 'error');
  } finally {
    activeClient = null;
    transport = null;
    mode = 'disconnected';
    busy = false;
    render();
  }
});

$('cancelButton').addEventListener('click', () => sendCommand(buildCommand('cancel'), '本体処理の中止'));
$('forgetAllButton').addEventListener('click', () => openDestructive('全登録を解除しますか？', 'PC3台と入力4枠の登録情報を解除します。配列などの設定は変更しません。', buildCommand('forget', 'all')));
$('clearLogButton').addEventListener('click', () => $('eventLog').replaceChildren(Object.assign(document.createElement('li'), { className: 'log-empty', textContent: 'ログを消去しました。' })));
$('confirmForm').addEventListener('submit', handleDialogSubmit);

// Keep the confirm control in the shared operation strip tied to firmware's ID.
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.id !== 'operationTitle') return;
});

// The firmware owns the confirmation ID.  Add its confirm action beside the
// cancel button only while the live UI is in confirm state.
function renderConfirmAction() {
  const meta = document.querySelector('.operation-meta');
  const old = $('confirmOperationButton');
  old?.remove();
  const status = currentStatus();
  if (!isLive() || !status || status.ui.state !== 'confirm' || status.ui.confirmationId <= 0) return;
  const button = makeButton('確認して続ける', 'button-primary', {
    disabled: !canChangeRegistration(),
    onClick: () => sendCommand(buildCommand('confirm', status.ui.confirmationId), '入れ替えの確定', { requiresUsb: true }),
  });
  button.id = 'confirmOperationButton';
  button.title = '新しい機器の登録を始めます。別機器への入れ替えは登録の保存後に反映し、中止・失敗・時間切れ・bond保存満杯では前の登録を保ちます。同じ機器の鍵交換後は新しい鍵を使います。';
  meta.prepend(button);
}

const baseRender = render;
render = function renderWithConfirm() { baseRender(); renderConfirmAction(); };

initConfiguration();
render();
window.requestAnimationFrame(paintLedFrame);

// End of application bootstrap.
