/**
 * MOOZ Studio Next — Main Application Controller
 * Connects UI, CAM Generators, Visualizer & Communication Engine
 * 100% Offline & Pure JS
 */

import { renderIcons } from './icons.js';
import { LaserGenerator } from './laser-generator.js';
import { CncGenerator } from './cnc-generator.js';
import { GcodeVisualizer } from './gcode-visualizer.js';
import { EngineCommunicationLayer } from './comm-layer.js';
import { CURA_PROFILES } from './cura-data.js';

// Machine bed geometries
const MACHINE_BEDS = {
  'mooz-1-2': { width: 130, depth: 130, height: 130, shape: 'rectangular' },
  'mooz-2-plus': { width: 200, depth: 200, height: 190, shape: 'rectangular' },
  'mooz-3': { width: 100, depth: 100, height: 100, shape: 'circular' }
};

// Application State
let currentTab = 'laser';
let currentModel = 'mooz-1-2';
let loadedImage = null;
let currentGcode = '';
let jogStep = 10;
let lockAspect = true;
let imageAspectRatio = 1.0;
let currentLaserMode = 'gray';
let currentCncTool = 'vBit';
let currentCuraQuality = 'fast';
let currentCuraMaterial = 'pla';
let laserAiming = false;
let spindleRunning = false;
let terminalHistory = [];
let historyIndex = -1;

// DOM Elements
const canvasVisualizer = document.getElementById('visualizer-canvas');
const gcodeOutput = document.getElementById('gcode-output');
const statTime = document.getElementById('stat-time');
const statLines = document.getElementById('stat-lines');
const statBounds = document.getElementById('stat-bounds');
const simSlider = document.getElementById('sim-slider');
const btnSimPlay = document.getElementById('btn-sim-play');
const viewModeText = document.getElementById('view-mode-text');

// Init Visualizer Canvas
function resizeVisualizerCanvas() {
  const rect = canvasVisualizer.parentElement.getBoundingClientRect();
  canvasVisualizer.width = rect.width || 600;
  canvasVisualizer.height = rect.height || 400;
}
resizeVisualizerCanvas();
window.addEventListener('resize', () => {
  resizeVisualizerCanvas();
  visualizer.resetView();
});

const visualizer = new GcodeVisualizer(canvasVisualizer, MACHINE_BEDS[currentModel]);

// Init Communication Engine
const comm = new EngineCommunicationLayer();

// Render All SVG Icons in document
renderIcons();

// ============================================================================
// 1. HARDWARE CONNECTION & PORTS
// ============================================================================
const selectPort = document.getElementById('select-port');
const selectModel = document.getElementById('select-model');
const btnRefreshPorts = document.getElementById('btn-refresh-ports');
const btnConnect = document.getElementById('btn-connect');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const footerPort = document.getElementById('footer-port');

async function updatePortList() {
  selectPort.innerHTML = '<option value="">Поиск портов...</option>';
  const ports = await comm.listPorts();
  selectPort.innerHTML = '';
  if (!ports || ports.length === 0) {
    selectPort.innerHTML = '<option value="">Порты не найдены</option>';
    return;
  }
  ports.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    selectPort.appendChild(opt);
  });
}
updatePortList();

btnRefreshPorts.addEventListener('click', updatePortList);

btnConnect.addEventListener('click', async () => {
  if (comm.isConnected) {
    await comm.disconnect();
    return;
  }
  const selectedPort = selectPort.value || 'COM3';
  await comm.connect(selectedPort, 115200);
});

comm.onStatusChange = (status) => {
  if (status.connected) {
    connDot.classList.add('connected');
    connText.textContent = 'Отключить';
    footerPort.textContent = `${status.port} (${status.mode})`;
    appendTerminalLog('info', `Подключено к ${status.port} [Режим: ${status.mode}]`);
  } else {
    connDot.classList.remove('connected');
    connText.textContent = 'Подключить';
    footerPort.textContent = 'Не подключен';
    appendTerminalLog('info', 'Станок отключен');
  }
};

comm.onPositionUpdate = (pos) => {
  if (pos.x !== undefined) document.getElementById('pos-x').textContent = `X: ${Number(pos.x).toFixed(2)}`;
  if (pos.y !== undefined) document.getElementById('pos-y').textContent = `Y: ${Number(pos.y).toFixed(2)}`;
  if (pos.z !== undefined) document.getElementById('pos-z').textContent = `Z: ${Number(pos.z).toFixed(2)}`;
  if (pos.e !== undefined) document.getElementById('pos-e').textContent = `E: ${Number(pos.e).toFixed(2)}`;
};

comm.onLogMessage = (type, msg) => {
  appendTerminalLog(type, msg);
};

// Machine Model Switch
selectModel.addEventListener('change', (e) => {
  currentModel = e.target.value;
  const bed = MACHINE_BEDS[currentModel];
  visualizer.setBedDimensions(bed.width, bed.depth, bed.height, bed.shape);
  updateCuraDisplay();
  appendTerminalLog('info', `Выбран станок: ${selectModel.options[selectModel.selectedIndex].text}`);
});

// ============================================================================
// 2. TAB NAVIGATION
// ============================================================================
const tabButtons = {
  laser: document.getElementById('tab-laser'),
  cnc: document.getElementById('tab-cnc'),
  '3d': document.getElementById('tab-3d'),
  control: document.getElementById('tab-control')
};

const panels = {
  laser: document.getElementById('panel-laser'),
  cnc: document.getElementById('panel-cnc'),
  '3d': document.getElementById('panel-3d'),
  control: document.getElementById('panel-control')
};

Object.keys(tabButtons).forEach(tab => {
  tabButtons[tab].addEventListener('click', () => {
    Object.values(tabButtons).forEach(b => b.classList.remove('active'));
    Object.values(panels).forEach(p => p.classList.add('hidden'));

    tabButtons[tab].classList.add('active');
    panels[tab].classList.remove('hidden');
    currentTab = tab;
  });
});

// ============================================================================
// 3. IMAGE LOADER & LIVE PREVIEW
// ============================================================================
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const dropZoneCnc = document.getElementById('drop-zone-cnc');
const fileInputCnc = document.getElementById('file-input-cnc');
const previewBox = document.getElementById('img-preview-box');
const previewCanvas = document.getElementById('preview-canvas');
const imgName = document.getElementById('img-name');
const imgRes = document.getElementById('img-res');
const btnClearImg = document.getElementById('btn-clear-img');

dropZone.addEventListener('click', () => fileInput.click());
dropZoneCnc.addEventListener('click', () => fileInputCnc.click());

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleImageFile(e.target.files[0]);
});
fileInputCnc.addEventListener('change', (e) => {
  if (e.target.files.length) handleImageFile(e.target.files[0]);
});

[dropZone, dropZoneCnc].forEach(zone => {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleImageFile(e.dataTransfer.files[0]);
    }
  });
});

// Global Paste (Ctrl+V) for instant clipboard images
window.addEventListener('paste', (e) => {
  const items = e.clipboardData ? e.clipboardData.items : [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      const file = items[i].getAsFile();
      handleImageFile(file, 'clipboard-image.png');
      break;
    }
  }
});

function handleImageFile(file, overrideName = null) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      imageAspectRatio = img.width / img.height;

      // Draw thumbnail preview
      const pctx = previewCanvas.getContext('2d');
      pctx.clearRect(0, 0, 56, 56);
      pctx.drawImage(img, 0, 0, 56, 56);

      imgName.textContent = overrideName || file.name || 'image.png';
      imgRes.textContent = `${img.width} × ${img.height} px`;
      previewBox.classList.remove('hidden');

      // Adjust height based on aspect ratio
      const w = parseFloat(document.getElementById('laser-width').value) || 50;
      document.getElementById('laser-height').value = Math.round(w / imageAspectRatio);

      appendTerminalLog('info', `Изображение загружено: ${img.width}×${img.height} px`);

      // Trigger CAM generation based on active tab
      if (currentTab === 'cnc') {
        generateCncGcode();
      } else {
        generateLaserGcode();
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

btnClearImg.addEventListener('click', (e) => {
  e.stopPropagation();
  loadedImage = null;
  previewBox.classList.add('hidden');
  fileInput.value = '';
  fileInputCnc.value = '';
  appendTerminalLog('info', 'Изображение удалено');
});

// Aspect Ratio lock
document.getElementById('laser-width').addEventListener('input', (e) => {
  if (lockAspect && loadedImage) {
    const w = parseFloat(e.target.value) || 1;
    document.getElementById('laser-height').value = Math.round(w / imageAspectRatio);
  }
});
document.getElementById('laser-height').addEventListener('input', (e) => {
  if (lockAspect && loadedImage) {
    const h = parseFloat(e.target.value) || 1;
    document.getElementById('laser-width').value = Math.round(h * imageAspectRatio);
  }
});

document.getElementById('btn-lock-aspect').addEventListener('click', () => {
  lockAspect = !lockAspect;
  document.getElementById('btn-lock-aspect').style.opacity = lockAspect ? '1' : '0.4';
});

// Mode buttons (Laser)
document.querySelectorAll('#laser-modes .tile-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#laser-modes .tile-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLaserMode = btn.dataset.mode;
    if (loadedImage) generateLaserGcode();
  });
});

// CNC Tool Buttons
document.querySelectorAll('#cnc-tools .tile-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#cnc-tools .tile-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCncTool = btn.dataset.tool;
  });
});

// Power Sliders
const sliderMax = document.getElementById('laser-power-max');
const labelMax = document.getElementById('label-power-max');
sliderMax.addEventListener('input', (e) => {
  const p = e.target.value;
  const s = Math.round(255 * (p / 100));
  labelMax.textContent = `${p}% (S${s})`;
});

const sliderMin = document.getElementById('laser-power-min');
const labelMin = document.getElementById('label-power-min');
sliderMin.addEventListener('input', (e) => {
  const p = e.target.value;
  const s = Math.round(255 * (p / 100));
  labelMin.textContent = `${p}% (S${s})`;
});

// ============================================================================
// 4. CAM GENERATORS (LASER & CNC)
// ============================================================================
document.getElementById('btn-generate-laser').addEventListener('click', generateLaserGcode);
document.getElementById('btn-generate-cnc').addEventListener('click', generateCncGcode);

function generateLaserGcode() {
  if (!loadedImage) {
    alert('Пожалуйста, сначала загрузите или перетащите изображение!');
    return;
  }

  appendTerminalLog('info', 'Генерация G-code для лазерной гравировки...');

  setTimeout(() => {
    const targetW = parseFloat(document.getElementById('laser-width').value) || 50;
    const targetH = parseFloat(document.getElementById('laser-height').value) || 50;

    // Rescale image for DPI resolution
    const dpi = 120;
    const pxW = Math.round(targetW * (dpi / 25.4));
    const pxH = Math.round(targetH * (dpi / 25.4));

    const offscreen = document.createElement('canvas');
    offscreen.width = pxW;
    offscreen.height = pxH;
    const octx = offscreen.getContext('2d');
    octx.drawImage(loadedImage, 0, 0, pxW, pxH);
    const imgData = octx.getImageData(0, 0, pxW, pxH);

    const generator = new LaserGenerator({
      engravingSpeed: parseInt(document.getElementById('laser-speed').value) || 1500,
      travelSpeed: parseInt(document.getElementById('laser-travel').value) || 3000,
      powerMax: parseInt(sliderMax.value) || 100,
      powerMin: parseInt(sliderMin.value) || 0,
      mode: currentLaserMode,
      targetWidth: targetW,
      targetHeight: targetH,
      invert: document.getElementById('laser-invert').checked,
      border: document.getElementById('laser-border').checked ? 1 : 0
    });

    const result = generator.generateFromImageData(imgData);
    currentGcode = result.gcode;

    gcodeOutput.value = currentGcode;
    statTime.textContent = `${result.estimatedTimeMinutes} мин`;
    statLines.textContent = result.linesCount.toLocaleString();
    statBounds.textContent = `${targetW.toFixed(0)} × ${targetH.toFixed(0)} mm`;

    visualizer.loadGcode(currentGcode);
    updateStreamStats();
    appendTerminalLog('info', `Лазерный G-code готов: ${result.linesCount} строк, ~${result.estimatedTimeMinutes} мин`);
  }, 10);
}

function generateCncGcode() {
  if (!loadedImage) {
    alert('Пожалуйста, сначала загрузите изображение карты высот (рельефа)!');
    return;
  }

  appendTerminalLog('info', 'Генерация G-code для ЧПУ фрезерования рельефа 2.5D...');

  setTimeout(() => {
    const targetW = parseFloat(document.getElementById('laser-width').value) || 50;
    const targetH = parseFloat(document.getElementById('laser-height').value) || 50;
    const pxW = Math.round(targetW * 3); // 3 samples/mm
    const pxH = Math.round(targetH * 3);

    const offscreen = document.createElement('canvas');
    offscreen.width = pxW;
    offscreen.height = pxH;
    const octx = offscreen.getContext('2d');
    octx.drawImage(loadedImage, 0, 0, pxW, pxH);
    const imgData = octx.getImageData(0, 0, pxW, pxH);

    const cncGen = new CncGenerator({
      cncSpeed: parseInt(document.getElementById('cnc-cut-speed').value) || 600,
      plungeSpeed: parseInt(document.getElementById('cnc-plunge-speed').value) || 200,
      totalDepth: parseFloat(document.getElementById('cnc-depth').value) || 2.0,
      stepDepth: parseFloat(document.getElementById('cnc-step').value) || 0.5,
      safeHeight: parseFloat(document.getElementById('cnc-safe').value) || 5.0,
      spindleSpeed: parseInt(document.getElementById('cnc-spindle').value) || 12000,
      toolType: currentCncTool,
      targetWidth: targetW,
      targetHeight: targetH
    });

    const result = cncGen.generateRelief(imgData);
    currentGcode = result.gcode;

    gcodeOutput.value = currentGcode;
    statTime.textContent = `${result.estimatedTimeMinutes} мин`;
    statLines.textContent = result.linesCount.toLocaleString();
    statBounds.textContent = `${targetW.toFixed(0)} × ${targetH.toFixed(0)} mm`;

    visualizer.loadGcode(currentGcode);
    updateStreamStats();
    appendTerminalLog('info', `ЧПУ G-code готов: ${result.linesCount} строк, ~${result.estimatedTimeMinutes} мин`);
  }, 10);
}

// ============================================================================
// 5. 3D CURA PROFILES & CONFIGURATION
// ============================================================================
function updateCuraDisplay() {
  const profile = CURA_PROFILES[currentModel] || CURA_PROFILES['mooz-1-2'];
  const startBox = document.getElementById('cura-start-gcode');
  const endBox = document.getElementById('cura-end-gcode');

  if (startBox) startBox.textContent = profile.startGcode;
  if (endBox) endBox.textContent = profile.endGcode;
}
updateCuraDisplay();

document.querySelectorAll('#cura-qualities .tile-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#cura-qualities .tile-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCuraQuality = btn.dataset.quality;
  });
});

document.querySelectorAll('#cura-materials .tile-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#cura-materials .tile-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCuraMaterial = btn.dataset.material;
  });
});

document.getElementById('btn-export-cura').addEventListener('click', () => {
  const profile = CURA_PROFILES[currentModel] || CURA_PROFILES['mooz-1-2'];
  const data = JSON.stringify(profile, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${profile.id}_cura_profile.json`;
  a.click();
  appendTerminalLog('info', `Экспортирован профиль Cura: ${a.download}`);
});

// ============================================================================
// 6. MANUAL JOG & CONTROL BUTTONS
// ============================================================================
document.querySelectorAll('#jog-step-selector .step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#jog-step-selector .step-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    jogStep = parseFloat(btn.dataset.step);
  });
});

document.getElementById('jog-x-plus').addEventListener('click', () => comm.jog('X', jogStep, 2000));
document.getElementById('jog-x-minus').addEventListener('click', () => comm.jog('X', -jogStep, 2000));
document.getElementById('jog-y-plus').addEventListener('click', () => comm.jog('Y', jogStep, 2000));
document.getElementById('jog-y-minus').addEventListener('click', () => comm.jog('Y', -jogStep, 2000));
document.getElementById('jog-z-plus').addEventListener('click', () => comm.jog('Z', jogStep, 1000));
document.getElementById('jog-z-minus').addEventListener('click', () => comm.jog('Z', -jogStep, 1000));

document.getElementById('btn-home').addEventListener('click', () => comm.home('XYZ'));
document.getElementById('btn-zero-axis').addEventListener('click', () => comm.sendGcode('G92 X0 Y0 Z0'));
document.getElementById('btn-estop').addEventListener('click', () => comm.emergencyStop());

document.getElementById('btn-laser-aim').addEventListener('click', (e) => {
  laserAiming = !laserAiming;
  if (laserAiming) {
    comm.sendGcode('M106 S12');
    e.currentTarget.style.background = 'var(--brand-orange)';
    e.currentTarget.style.color = '#fff';
    appendTerminalLog('info', 'Лазер-прицел ВКЛ (мощность 5%)');
  } else {
    comm.sendGcode('M106 S0');
    e.currentTarget.style.background = '';
    e.currentTarget.style.color = '';
    appendTerminalLog('info', 'Лазер-прицел ВЫКЛ');
  }
});

document.getElementById('btn-spindle-toggle').addEventListener('click', (e) => {
  spindleRunning = !spindleRunning;
  if (spindleRunning) {
    const rpm = parseInt(document.getElementById('cnc-spindle').value) || 12000;
    comm.sendGcode(`M3 S${rpm}`);
    e.currentTarget.style.background = 'var(--accent-cyan)';
    e.currentTarget.style.color = '#fff';
    appendTerminalLog('info', `Шпиндель ВКЛ (${rpm} RPM)`);
  } else {
    comm.sendGcode('M5');
    e.currentTarget.style.background = '';
    e.currentTarget.style.color = '';
    appendTerminalLog('info', 'Шпиндель ВЫКЛ');
  }
});

// ============================================================================
// 7. VISUALIZER CONTROLS & SIMULATION
// ============================================================================
document.getElementById('btn-view-mode').addEventListener('click', () => {
  if (visualizer.viewMode === '2d') {
    visualizer.setViewMode('3d');
    viewModeText.textContent = 'Вид: 3D';
  } else {
    visualizer.setViewMode('2d');
    viewModeText.textContent = 'Вид: 2D';
  }
});

document.getElementById('btn-zoom-in').addEventListener('click', () => visualizer.zoomIn());
document.getElementById('btn-zoom-out').addEventListener('click', () => visualizer.zoomOut());
document.getElementById('btn-reset-view').addEventListener('click', () => visualizer.resetView());

document.getElementById('btn-copy-gcode').addEventListener('click', () => {
  if (!currentGcode) return;
  navigator.clipboard.writeText(currentGcode).then(() => {
    alert('G-code скопирован в буфер обмена!');
  });
});

document.getElementById('btn-download-gcode').addEventListener('click', () => {
  if (!currentGcode) {
    alert('Сначала сгенерируйте G-code!');
    return;
  }
  const blob = new Blob([currentGcode], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mooz_${currentTab}_${Date.now()}.gcode`;
  a.click();
});

// Simulation Play/Pause & Scrub
btnSimPlay.addEventListener('click', () => {
  if (visualizer.isPlaying) {
    visualizer.pauseSimulation();
    btnSimPlay.innerHTML = `<span data-icon="play" data-icon-size="14"></span>`;
    renderIcons(btnSimPlay);
  } else {
    btnSimPlay.innerHTML = `<span data-icon="pause" data-icon-size="14"></span>`;
    renderIcons(btnSimPlay);
    visualizer.startSimulation((idx, total) => {
      const pct = Math.round((idx / total) * 100);
      simSlider.value = pct;
      if (idx >= total) {
        btnSimPlay.innerHTML = `<span data-icon="play" data-icon-size="14"></span>`;
        renderIcons(btnSimPlay);
      }
    });
  }
});

simSlider.addEventListener('input', (e) => {
  const ratio = parseFloat(e.target.value) / 100;
  visualizer.setSimulationProgress(ratio);
});

// ============================================================================
// 8. G-CODE STREAM CONTROLLER
// ============================================================================
const btnStreamStart = document.getElementById('btn-stream-start');
const btnStreamPause = document.getElementById('btn-stream-pause');
const btnStreamStop = document.getElementById('btn-stream-stop');
const streamProgressFill = document.getElementById('stream-progress-fill');
const streamLinesMeta = document.getElementById('stream-lines-meta');
const streamPercentMeta = document.getElementById('stream-percent-meta');
const badgeStreamState = document.getElementById('badge-stream-state');

function updateStreamStats() {
  const lines = currentGcode ? currentGcode.split('\n').filter(l => l.trim() && !l.trim().startsWith(';')).length : 0;
  streamLinesMeta.textContent = `0 / ${lines} строк`;
  streamPercentMeta.textContent = '0%';
  streamProgressFill.style.width = '0%';
}

btnStreamStart.addEventListener('click', async () => {
  if (!currentGcode) {
    alert('Сначала сгенерируйте G-code!');
    return;
  }
  if (!comm.isConnected) {
    if (!confirm('Станок не подключен по USB. Начать потоковую отправку в режиме эмуляции?')) {
      return;
    }
  }

  btnStreamStart.style.display = 'none';
  btnStreamPause.style.display = 'flex';
  btnStreamStop.style.display = 'flex';
  badgeStreamState.textContent = 'Печать';
  badgeStreamState.className = 'status-tag active';

  await comm.streamGcode(currentGcode);

  btnStreamStart.style.display = 'flex';
  btnStreamPause.style.display = 'none';
  btnStreamStop.style.display = 'none';
  badgeStreamState.textContent = 'Готов';
  badgeStreamState.className = 'status-tag';
});

btnStreamPause.addEventListener('click', async () => {
  if (comm.streamPaused) {
    await comm.resumeStream();
    btnStreamPause.innerHTML = `<span data-icon="pause" data-icon-size="14"></span>`;
    badgeStreamState.textContent = 'Печать';
    badgeStreamState.className = 'status-tag active';
  } else {
    await comm.pauseStream();
    btnStreamPause.innerHTML = `<span data-icon="play" data-icon-size="14"></span>`;
    badgeStreamState.textContent = 'Пауза';
    badgeStreamState.className = 'status-tag paused';
  }
  renderIcons(btnStreamPause);
});

btnStreamStop.addEventListener('click', async () => {
  await comm.cancelStream();
  btnStreamStart.style.display = 'flex';
  btnStreamPause.style.display = 'none';
  btnStreamStop.style.display = 'none';
  badgeStreamState.textContent = 'Остановлен';
  badgeStreamState.className = 'status-tag stopped';
});

comm.onProgressUpdate = (prog) => {
  const percent = prog.progressPercent || 0;
  streamProgressFill.style.width = `${percent}%`;
  streamPercentMeta.textContent = `${percent}%`;
  streamLinesMeta.textContent = `${prog.currentLine || 0} / ${prog.totalLines || 0} строк`;
};

// ============================================================================
// 9. INTERACTIVE TERMINAL
// ============================================================================
const terminalLog = document.getElementById('terminal-log');
const terminalInput = document.getElementById('terminal-input');
const btnTerminalSend = document.getElementById('btn-terminal-send');
const btnClearTerminal = document.getElementById('btn-clear-terminal');

function appendTerminalLog(type, msg) {
  const time = new Date().toTimeString().split(' ')[0];
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">[${time}]</span> <span>${escapeHtml(msg)}</span>`;
  terminalLog.appendChild(div);
  terminalLog.scrollTop = terminalLog.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleTerminalSubmit() {
  const cmd = terminalInput.value.trim();
  if (!cmd) return;

  terminalHistory.push(cmd);
  historyIndex = terminalHistory.length;
  terminalInput.value = '';

  await comm.sendGcode(cmd);
}

btnTerminalSend.addEventListener('click', handleTerminalSubmit);

terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    handleTerminalSubmit();
  } else if (e.key === 'ArrowUp') {
    if (historyIndex > 0) {
      historyIndex--;
      terminalInput.value = terminalHistory[historyIndex];
    }
  } else if (e.key === 'ArrowDown') {
    if (historyIndex < terminalHistory.length - 1) {
      historyIndex++;
      terminalInput.value = terminalHistory[historyIndex];
    } else {
      historyIndex = terminalHistory.length;
      terminalInput.value = '';
    }
  }
});

btnClearTerminal.addEventListener('click', () => {
  terminalLog.innerHTML = '';
});
