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
  rgbAt,
  SerialClient,
  buildCommand,
} from './protocol.js';

const INPUT_LABELS = Object.freeze({ k1: 'キーボード1', k2: 'キーボード2', m1: 'マウス1', m2: 'マウス2' });
const INPUT_TYPES = Object.freeze({ k1: 'kbd', k2: 'kbd', m1: 'mouse', m2: 'mouse' });
const PATTERNS = Object.freeze({
  pc1: { name: 'PC1', detail: '赤・選択中のPC', ledState: { state: 'normal', selectedPc: 1, registered: true, connected: true } },
  pc2: { name: 'PC2', detail: '緑・選択中のPC', ledState: { state: 'normal', selectedPc: 2, registered: true, connected: true } },
  pc3: { name: 'PC3', detail: '青・選択中のPC', ledState: { state: 'normal', selectedPc: 3, registered: true, connected: true } },
  'input-k1': { name: 'キーボード1', detail: '黄・1回短点滅', ledState: { state: 'select-input', target: 'k1' } },
  'input-k2': { name: 'キーボード2', detail: '黄・2回短点滅', ledState: { state: 'select-input', target: 'k2' } },
  'input-m1': { name: 'マウス1', detail: '水色・3回短点滅', ledState: { state: 'select-input', target: 'm1' } },
  'input-m2': { name: 'マウス2', detail: '水色・4回短点滅', ledState: { state: 'select-input', target: 'm2' } },
  pairing: { name: '登録中', detail: '対象の短点滅群に続く長点灯', ledState: { state: 'pairing', target: 'k1' } },
  confirm: { name: '入れ替え確認', detail: '対象の表示に続く紫の長点灯', ledState: { state: 'confirm', target: 'pc2' } },
  success: { name: '登録成功', detail: '白を600ms点灯して通常表示へ', ledState: { state: 'success', previous: { state: 'normal', selectedPc: 1, registered: true, connected: true } } },
  failure: { name: '失敗・時間切れ', detail: '白を100msずつ3回点滅', ledState: { state: 'failure', previous: { state: 'normal', selectedPc: 1, registered: true, connected: true } } },
  cancel: { name: '確認時間切れ', detail: '200ms消灯して通常表示へ', ledState: { state: 'cancel', previous: { state: 'normal', selectedPc: 1, registered: true, connected: true } } },
  idle: { name: '本体未接続', detail: '本体の状態を取得できません', ledState: null },
});

const $ = (id) => document.getElementById(id);
const store = new DeviceStateStore();
const client = new SerialClient({ store });
let mode = 'disconnected';
let demoStatus = null;
let demoPattern = 'pc1';
let pendingDestructive = null;
let busy = false;
let lastResponse = null;
let activeLedPatternKey = null;
let activeLedState = null;
let ledEpoch = 0;

function makeDemoStatus() {
  return {
    protocol: 2,
    selectedPc: 1,
    pcs: [
      { registered: true, connected: true, name: null },
      { registered: true, connected: false, name: null },
      { registered: false, connected: false, name: null },
    ],
    inputs: [
      { id: 'k1', slot: 1, registered: true, connected: true, name: null },
      { id: 'k2', slot: null, registered: false, connected: false, name: null },
      { id: 'm1', slot: 2, registered: true, connected: false, name: null },
      { id: 'm2', slot: null, registered: false, connected: false, name: null },
    ],
    legacyInputs: [{ slot: 4, registered: true, connected: false }],
    config: { inputLayouts: ['us', 'us', 'us', 'jis'], outputLayouts: ['us', 'jis', 'us'], outputOs: ['macos', 'windows', 'unspecified'] },
    ui: { state: 'normal', target: null, operation: null, remainingMs: 0, result: '', resultRemainingMs: 0, confirmationId: 0 },
  };
}

function currentStatus() {
  if (mode === 'demo') return demoStatus;
  return store.snapshot().status;
}

function isLive() {
  return mode === 'live' && store.snapshot().connected && currentStatus() !== null;
}

function canSend() {
  return isLive() && !busy;
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
  return entry?.registered ? '機器名未取得' : fallback;
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
  const demo = mode === 'demo';
  pill.dataset.state = connected ? 'connected' : demo ? 'demo' : 'disconnected';
  label.textContent = connected ? 'USBシリアル接続中' : demo ? 'デモモード' : '設定画面未接続';
  $('connectButton').disabled = connected || busy;
  $('connectButton').textContent = demo ? 'デモを閉じる' : 'UART USBに接続';
  $('disconnectButton').disabled = !connected || busy;
  $('demoButton').disabled = connected || busy;
  $('demoButton').textContent = demo ? 'デモを閉じる' : 'デモを開く';
}

function renderNotice() {
  const notice = $('modeNotice');
  const title = $('modeTitle');
  const description = $('modeDescription');
  notice.dataset.mode = mode === 'live' ? 'live' : mode === 'demo' ? 'demo' : 'disconnected';
  if (mode === 'live') {
    title.textContent = currentStatus() ? '本体に接続しています' : '本体に接続済み・状態を待っています';
    description.textContent = currentStatus()
      ? '表示中の登録・接続・操作状態は、本体から受け取った最新の情報です。'
      : '本体の状態が届くまで操作を無効にしています。';
  } else if (mode === 'demo') {
    title.textContent = 'デモモード — 本体へは送信しません';
    description.textContent = 'カードの操作ボタンは無効です。下のLEDパターンだけを、実機なしで確認できます。';
  } else {
    title.textContent = '設定画面と本体が未接続';
    description.textContent = '基板写真の向きで右側にある UART USB ポートをPCへ接続し、「UART USBに接続」を押してください。';
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
    detail.textContent = mode === 'demo' ? 'デモの状態がありません。デモを開き直してください。' : '本体の状態が届くまで、画面側では状態を推測しません。';
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
  if (mode === 'demo') {
    title.textContent = 'デモの状態';
    detail.textContent = 'これは実機の状態ではありません。';
  } else if (ui.state === 'normal') {
    title.textContent = `通常表示 · 選択中 ${formatTarget(`pc${status.selectedPc}`)}`;
    detail.textContent = 'PCの短押しは出力先を選択し、入力はそのPCへまとめて送られます。';
  } else if (ui.state === 'confirm') {
    title.textContent = `${describeUiState(ui.state)} · ${formatTarget(ui.target)}`;
    detail.textContent = '確認して続けると古い登録を削除し、新しい登録待ちになります。失敗・中止の場合は未登録のままです。PC側で再ペアリングが必要になる場合があります。';
    if (ui.remainingMs > 0) remaining.textContent = formatDuration(ui.remainingMs);
    cancel.hidden = mode === 'demo';
  } else {
    title.textContent = `${describeUiState(ui.state)} · ${formatTarget(ui.target)}`;
    detail.textContent = `${ui.operation ? `操作: ${describeOperation(ui.operation)}` : '本体が処理中です'}。完了・失敗は本体からの結果を待ちます。`;
    if (ui.remainingMs > 0) remaining.textContent = formatDuration(ui.remainingMs);
    cancel.hidden = mode === 'demo';
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
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const disabled = !canSend();
    actions.append(makeButton(selected ? '選択中' : '出力先に選択', 'button-soft', {
      disabled: disabled || selected,
      title: mode === 'demo' ? 'デモ中はコマンドを送信しません' : '',
      ariaLabel: `PC${pcNumber}${selected ? 'は選択中' : 'を出力先に選択'}`,
      onClick: () => sendCommand(buildCommand('select', pcNumber), `PC${pcNumber}を選択`),
    }));
    if (entry.registered) {
      actions.append(makeButton('入れ替え', 'button-ghost', {
        disabled,
        title: '確認して続けると古い登録を削除します。失敗・中止の場合は未登録のままです。',
        ariaLabel: `PC${pcNumber}を入れ替え`,
        onClick: () => sendCommand(buildCommand('replace', 'pc', pcNumber), `PC${pcNumber}の入れ替え確認`),
      }));
      actions.append(makeButton('登録解除', 'button-danger-outline', {
        disabled,
        ariaLabel: `PC${pcNumber}の登録を解除`,
        onClick: () => openDestructive(`PC${pcNumber}の登録を解除しますか？`, '現在のPC登録だけを解除します。入力枠や他のPCは変更しません。', buildCommand('forget', 'pc', pcNumber)),
      }));
    } else {
      actions.append(makeButton('登録する', 'button-ghost', {
        disabled,
        ariaLabel: `PC${pcNumber}を登録`,
        onClick: () => sendCommand(buildCommand('pair', 'pc', pcNumber), `PC${pcNumber}の登録`),
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
    addStatusChip(rows, entry.slot === null ? '物理枠 未割当' : `物理枠 ${entry.slot}`, entry.slot === null ? 'unknown' : 'connected');
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const disabled = !canSend();
    if (entry.registered) {
      actions.append(makeButton('入れ替え', 'button-ghost', {
        disabled,
        title: '確認して続けると古い登録を削除します。失敗・中止の場合は未登録のままです。',
        ariaLabel: `${label}を入れ替え`,
        onClick: () => sendCommand(buildCommand('replace', 'input', key), `${label}の入れ替え確認`),
      }));
      actions.append(makeButton('登録解除', 'button-danger-outline', {
        disabled,
        ariaLabel: `${label}の登録を解除`,
        onClick: () => openDestructive(`${label}の登録を解除しますか？`, 'この入力枠だけを解除します。他の入力枠やPC登録は変更しません。', buildCommand('forget', 'input', key)),
      }));
    } else {
      actions.append(makeButton('登録する', 'button-ghost', {
        disabled,
        ariaLabel: `${label}を登録`,
        onClick: () => sendCommand(buildCommand('pair', 'input', key), `${label}の登録`),
      }));
    }
    card.append(actions);
    const footnote = document.createElement('p');
    footnote.className = 'card-footnote';
    footnote.textContent = entry.name === null && entry.registered ? '機器名を取得できませんでした。' : '入力枠はPCの出力先選択とは独立しています。';
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
  select.setAttribute('aria-label', `${scope === 'pc' ? 'PC' : '物理枠'}${slot}の${label}`);
  for (const value of choices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = CONFIG_LABELS[value];
    select.append(option);
  }
  const current = document.createElement('span');
  current.className = 'config-current';
  const control = { scope, slot, field, select, current, saved: null, dirty: false, button: null };
  const button = makeButton('保存', 'button-soft', {
    ariaLabel: `${scope === 'pc' ? 'PC' : '物理枠'}${slot}の${label}を保存`,
    onClick: () => sendCommand(buildCommand('set', scope, slot, field, select.value), `${label}を保存`),
  });
  control.button = button;
  select.addEventListener('change', () => { control.dirty = select.value !== control.saved; renderConfiguration(); });
  configControls.set(key, control);
  row.append(caption, select, button, current);
  parent.append(row);
}

function initConfiguration() {
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
    $('inputConfig').append(panel);
  }
}

function renderConfiguration() {
  const status = currentStatus();
  const config = status?.config;
  $('configAvailability').textContent = !status ? '設定を取得できません。' : !config ? 'このファームは設定の読み出しに未対応です。' : mode === 'demo' ? 'デモの設定例です。保存できません。' : '保存後、本体から届く設定値を確認します。';
  for (const [slot, title] of configInputTitles) {
    const role = status?.inputs.find((entry) => entry.slot === slot);
    const legacy = status?.legacyInputs.some((entry) => entry.slot === slot);
    title.textContent = `物理枠${slot} · ${role ? INPUT_LABELS[role.id] : legacy ? '割当待ち' : '未割当'}`;
  }
  for (const control of configControls.values()) {
    const values = control.scope === 'input' ? config?.inputLayouts : control.field === 'os' ? config?.outputOs : config?.outputLayouts;
    const saved = values?.[control.slot - 1] ?? null;
    if (saved === null) {
      control.dirty = false;
      control.select.selectedIndex = -1;
    } else if (!control.dirty || control.select.value === saved) {
      control.select.value = saved;
      control.dirty = false;
    }
    control.saved = saved;
    control.current.textContent = saved === null ? '保存値は不明' : `本体の保存値: ${CONFIG_LABELS[saved]}${control.dirty ? ' · 未保存の変更あり' : ''}`;
    const disabled = !canSend() || !config || status.ui.state !== 'normal';
    control.select.disabled = disabled;
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
    name.textContent = candidate.name === null ? '機器名未取得' : candidate.name;
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
      disabled: !canSend(),
      ariaLabel: `候補${candidate.id}を選択`,
      title: mode === 'demo' ? 'デモ中はコマンドを送信しません' : '',
      onClick: () => sendCommand(
        buildCommand('choose', 'input', status.candidateGeneration, candidate.id),
        `候補${candidate.id}を選択`,
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
    card.append(rows);
    const actions = document.createElement('div');
    actions.className = 'legacy-actions';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `物理スロット${entry.slot}の割り当て先`);
    for (const key of INPUT_KEYS) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = INPUT_LABELS[key];
      select.append(option);
    }
    const assign = makeButton('この枠へ割り当て', 'button-soft', {
      disabled: !canSend(),
      title: mode === 'demo' ? 'デモ中はコマンドを送信しません' : '',
      onClick: () => sendCommand(buildCommand('assign', 'input', entry.slot, select.value), `物理スロット${entry.slot}の割り当て`),
    });
    actions.append(select, assign);
    card.append(actions);
    root.append(card);
  }
}

function setLed(patternKey, stateOverride = undefined, elapsedMs = 0) {
  const pattern = PATTERNS[patternKey] ?? PATTERNS.idle;
  const nextState = stateOverride === undefined ? pattern.ledState : stateOverride;
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
  for (const button of document.querySelectorAll('[data-pattern]')) button.dataset.active = String(button.dataset.pattern === patternKey);
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
  $('ledSource').textContent = mode === 'live' ? '本体状態に連動' : mode === 'demo' ? 'デモ（送信なし）' : '本体状態なし';
  if (mode === 'demo') {
    setLed(demoPattern, PATTERNS[demoPattern]?.ledState);
    return;
  }
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
  } else if (ui.state === 'select-input') {
    setLed(`input-${ui.target}`, { state: 'select-input', target: ui.target });
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
  renderConnection();
  renderNotice();
  renderOperation();
  renderPcCards();
  renderInputCards();
  renderCandidates();
  renderLegacyCards();
  renderConfiguration();
  renderLed();
  $('forgetAllButton').disabled = !canSend();
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

async function sendCommand(command, label) {
  if (!canSend()) return;
  busy = true;
  renderConnection();
  renderPcCards();
  renderInputCards();
  renderCandidates();
  renderLegacyCards();
  renderConfiguration();
  appendLog(`送信: ${command}${label ? ` · ${label}` : ''}`);
  try {
    await client.send(command);
    lastResponse = { ok: true };
  } catch (error) {
    lastResponse = { ok: false, error: error.message };
    appendLog(`送信失敗: ${error.message}`, 'error');
  } finally {
    busy = false;
    render();
  }
}

function openDestructive(title, message, command) {
  if (!isLive()) return;
  pendingDestructive = { command, label: title };
  $('dialogTitle').textContent = title;
  $('dialogMessage').textContent = message;
  $('dialogConfirm').textContent = '解除する';
  const dialog = $('confirmDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else if (window.confirm(`${title}\n\n${message}`)) {
    const pending = pendingDestructive;
    pendingDestructive = null;
    sendCommand(pending.command, pending.label);
  }
}

function handleDialogSubmit(event) {
  event.preventDefault();
  const submitter = event.submitter?.value;
  const pending = pendingDestructive;
  pendingDestructive = null;
  $('confirmDialog').close();
  if (submitter === 'confirm' && pending) sendCommand(pending.command, pending.label);
}

function onResponse(response) {
  if (response.ok) appendLog(`応答: OK${response.error ? ` (${response.error})` : ''}`, 'ok');
  else appendLog(`応答: NG${response.error ? ` (${response.error})` : ''}`, 'error');
  lastResponse = response.ok ? { ok: true } : { ok: false, error: response.error };
  render();
}

store.subscribe(() => {
  const snapshot = store.snapshot();
  if (mode !== 'demo') mode = snapshot.connected ? 'live' : 'disconnected';
  render();
});
client.on('connected', () => { mode = 'live'; appendLog('シリアル接続: 115200 bps', 'ok'); render(); });
client.on('disconnected', () => { mode = 'disconnected'; appendLog('シリアル接続が切れました。古い状態を消去しました。', 'error'); render(); });
client.on('status', (status) => { appendLog(`status: PC${status.selectedPc} / UI ${status.ui.state}`); });
client.on('response', onResponse);
client.on('line', (event) => {
  if (event.kind === 'log') appendLog(`ログ: ${event.line}`);
  if (event.kind === 'invalid-json') appendLog(`無効なJSONを無視: ${event.line}`, 'error');
});
client.on('error', (error) => { lastResponse = { ok: false, error: error.message }; appendLog(`通信エラー: ${error.message}`, 'error'); render(); });

$('connectButton').addEventListener('click', async () => {
  if (mode === 'demo') { mode = 'disconnected'; demoStatus = null; render(); return; }
  if (busy) return;
  busy = true;
  renderConnection();
  try {
    await client.connect();
    mode = 'live';
  } catch (error) {
    mode = 'disconnected';
    lastResponse = { ok: false, error: error.message };
    appendLog(`接続失敗: ${error.message}`, 'error');
  } finally {
    busy = false;
    render();
  }
});

$('disconnectButton').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  renderConnection();
  await client.disconnect();
  busy = false;
  mode = 'disconnected';
  render();
});

$('demoButton').addEventListener('click', () => {
  if (mode === 'demo') {
    mode = 'disconnected';
    demoStatus = null;
  } else {
    mode = 'demo';
    demoStatus = makeDemoStatus();
    demoPattern = 'pc1';
  }
  render();
});

for (const button of document.querySelectorAll('[data-pattern]')) {
  button.addEventListener('click', () => {
    if (mode !== 'demo') return;
    demoPattern = button.dataset.pattern;
    renderLed();
  });
}

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
    disabled: !canSend(),
    onClick: () => sendCommand(buildCommand('confirm', status.ui.confirmationId), '入れ替えの確定'),
  });
  button.id = 'confirmOperationButton';
  button.title = '古い登録を削除して新しい登録待ちにします。失敗・中止の場合は未登録のままです。';
  meta.prepend(button);
}

const baseRender = render;
render = function renderWithConfirm() { baseRender(); renderConfirmAction(); };

initConfiguration();
render();
window.requestAnimationFrame(paintLedFrame);

// End of application bootstrap.
