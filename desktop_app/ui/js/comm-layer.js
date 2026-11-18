/**
 * Unified Communication Layer for MOOZ Studio Next
 * Transparently connects to:
 * 1) PyWebView native JS API (window.pywebview.api)
 * 2) Local Python Engine HTTP Server (http://127.0.0.1:9999 or window.location.origin)
 * 3) Direct Web Serial API (navigator.serial)
 * 100% Offline & Fault Tolerant
 */

import { buildGcodePacket, parseMoozData } from './mooz-protocol.js';

export class EngineCommunicationLayer {
  constructor() {
    this.mode = 'detecting'; // 'pywebview', 'http', 'webserial', 'simulated'
    this.httpBaseUrl = (window.location.protocol.startsWith('http')) 
      ? window.location.origin 
      : 'http://127.0.0.1:9999';

    this.isConnected = false;
    this.currentPort = '';
    this.baudRate = 115200;

    // Web Serial state
    this.serialPort = null;
    this.serialWriter = null;
    this.serialReader = null;

    // Callbacks
    this.onStatusChange = null;
    this.onLogMessage = null;
    this.onPositionUpdate = null;
    this.onProgressUpdate = null;

    // Streaming state
    this.isStreaming = false;
    this.streamPaused = false;
    this.streamCancelRequested = false;
    this.pollInterval = null;

    this._detectEnvironment();
  }

  async _detectEnvironment() {
    // 1. Check pywebview
    if (window.pywebview && window.pywebview.api) {
      this.mode = 'pywebview';
      this._log('info', 'Нативный мост PyWebView готов');
      this._checkInitialStatus();
      return;
    }

    window.addEventListener('pywebviewready', () => {
      this.mode = 'pywebview';
      this._log('info', 'Нативный мост PyWebView инициализирован');
      this._checkInitialStatus();
    });

    // 2. Check HTTP API
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/status`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        this.mode = 'http';
        const data = await res.json();
        this._log('info', `Подключен локальный HTTP API: ${this.httpBaseUrl}`);
        if (data.connected) {
          this.isConnected = true;
          this.currentPort = data.port;
          this._notifyStatus();
        }
        this._startPolling();
        return;
      }
    } catch (e) {
      // HTTP server not reachable
    }

    // 3. Check Web Serial
    if (navigator.serial) {
      this.mode = 'webserial';
      this._log('info', 'Доступен Web Serial API (прямой USB)');
      return;
    }

    this.mode = 'simulated';
    this._log('info', 'Автономный режим (эмуляция станка)');
  }

  async _checkInitialStatus() {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.get_status) {
      try {
        const st = await window.pywebview.api.get_status();
        if (st && st.connected) {
          this.isConnected = true;
          this.currentPort = st.port;
          this._notifyStatus();
        }
        this._startPolling();
      } catch (e) {}
    }
  }

  _log(type, msg) {
    if (this.onLogMessage) {
      this.onLogMessage(type, msg);
    }
  }

  /**
   * Retrieves list of available serial ports
   */
  async listPorts() {
    // 1. PyWebView
    if (window.pywebview && window.pywebview.api && window.pywebview.api.get_ports) {
      try {
        const ports = await window.pywebview.api.get_ports();
        return this._formatPorts(ports);
      } catch (e) {
        console.warn('pywebview get_ports error:', e);
      }
    }

    // 2. HTTP Server
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/ports`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) {
        const data = await res.json();
        return this._formatPorts(data.ports);
      }
    } catch (e) {
      // Fallback
    }

    // 3. Web Serial
    if (navigator.serial) {
      try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          return ports.map((p, idx) => `USB Port ${idx + 1}`);
        }
      } catch (e) {}
    }

    return ['COM3 (CH340 Dobot MOOZ)', 'COM4', 'COM5'];
  }

  _formatPorts(ports) {
    if (!Array.isArray(ports)) return [];
    return ports.map(p => {
      if (typeof p === 'string') return p;
      if (p && p.device) {
        return p.description && p.description !== 'n/a' ? `${p.device} (${p.description})` : p.device;
      }
      return String(p);
    });
  }

  /**
   * Connect to Dobot MOOZ serial port
   */
  async connect(portName = 'COM3', baud = 115200) {
    this.baudRate = baud;
    // Extract clean device name (e.g. 'COM3' from 'COM3 (CH340 ...)')
    const cleanPort = portName.split(' ')[0];
    this.currentPort = cleanPort;

    // 1. PyWebView
    if (window.pywebview && window.pywebview.api && window.pywebview.api.connect) {
      try {
        const res = await window.pywebview.api.connect(cleanPort, baud);
        if (res && res.success) {
          this.isConnected = true;
          this.mode = 'pywebview';
          this._notifyStatus();
          this._startPolling();
          this._log('info', `[PyWebView] Подключено к ${cleanPort} (${baud} 8N1)`);
          return true;
        }
      } catch (e) {
        this._log('err', `PyWebView connect error: ${e}`);
      }
    }

    // 2. HTTP Server
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: cleanPort, baudrate: baud }),
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          this.isConnected = true;
          this.mode = 'http';
          this._notifyStatus();
          this._startPolling();
          this._log('info', `[HTTP Engine] Подключено к ${cleanPort} (${baud} 8N1)`);
          return true;
        }
      }
    } catch (e) {
      // Not HTTP
    }

    // 3. Web Serial API
    if (navigator.serial) {
      try {
        this.serialPort = await navigator.serial.requestPort();
        await this.serialPort.open({ baudRate: baud });
        this.serialWriter = this.serialPort.writable.getWriter();
        this.isConnected = true;
        this.mode = 'webserial';
        this._notifyStatus();
        this._readSerialLoop();
        this._log('info', `[Web Serial] Подключено к порту (${baud} 8N1)`);
        return true;
      } catch (e) {
        this._log('err', `Web Serial ошибка: ${e.message}`);
      }
    }

    // 4. Simulated Fallback
    this.isConnected = true;
    this.mode = 'simulated';
    this._notifyStatus();
    this._log('info', `[Эмуляция] Виртуальное подключение к ${cleanPort} (${baud} 8N1)`);
    return true;
  }

  /**
   * Disconnect port
   */
  async disconnect() {
    this.isConnected = false;

    if (window.pywebview && window.pywebview.api && window.pywebview.api.disconnect) {
      try { await window.pywebview.api.disconnect(); } catch (e) {}
    }

    try {
      await fetch(`${this.httpBaseUrl}/api/disconnect`, { method: 'POST', signal: AbortSignal.timeout(1000) });
    } catch (e) {}

    if (this.serialWriter) {
      try { this.serialWriter.releaseLock(); } catch (e) {}
      this.serialWriter = null;
    }
    if (this.serialReader) {
      try { this.serialReader.releaseLock(); } catch (e) {}
      this.serialReader = null;
    }
    if (this.serialPort) {
      try { await this.serialPort.close(); } catch (e) {}
      this.serialPort = null;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this._notifyStatus();
    this._log('info', 'Станок отключен');
  }

  /**
   * Send single G-code or command
   */
  async sendGcode(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    this._log('tx', trimmed);

    if (window.pywebview && window.pywebview.api && window.pywebview.api.send_gcode) {
      try {
        const res = await window.pywebview.api.send_gcode(trimmed);
        return res;
      } catch (e) {
        this._log('err', `API send error: ${e}`);
      }
    }

    if (this.mode === 'http') {
      try {
        const res = await fetch(`${this.httpBaseUrl}/api/send_gcode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gcode: trimmed })
        });
        const data = await res.json();
        return data;
      } catch (e) {
        this._log('err', `HTTP send error: ${e}`);
      }
    }

    if (this.mode === 'webserial' && this.serialWriter) {
      try {
        const packet = buildGcodePacket(trimmed);
        await this.serialWriter.write(packet);
        return;
      } catch (e) {
        this._log('err', `Serial write error: ${e}`);
      }
    }

    // Simulated reply
    setTimeout(() => {
      if (trimmed.includes('G28')) {
        this._log('rx', 'ok (Homed X0 Y0 Z0)');
        if (this.onPositionUpdate) this.onPositionUpdate({ x: 0, y: 0, z: 0, e: 0 });
      } else if (trimmed.includes('M105')) {
        this._log('rx', 'ok T:205.0 /205.0 B:60.0 /60.0');
      } else if (trimmed.includes('M114')) {
        this._log('rx', 'ok C: X:10.00 Y:10.00 Z:0.00 E:0.00');
      } else {
        this._log('rx', 'ok');
      }
    }, 30);
  }

  /**
   * Manual Jog Axis move
   */
  async jog(axis, distance, feedrate = 1500) {
    this._log('tx', `JOG ${axis} ${distance} mm (F${feedrate})`);

    if (window.pywebview && window.pywebview.api && window.pywebview.api.jog) {
      try {
        return await window.pywebview.api.jog(axis, distance, feedrate);
      } catch (e) {}
    }

    if (this.mode === 'http') {
      try {
        const res = await fetch(`${this.httpBaseUrl}/api/jog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ axis, distance, feedrate })
        });
        return await res.json();
      } catch (e) {}
    }

    // Direct G-code jog
    const gcode = `G91\nG1 ${axis.toUpperCase()}${distance} F${feedrate}\nG90`;
    await this.sendGcode(gcode);
  }

  /**
   * Home axes
   */
  async home(axes = 'XYZ') {
    this._log('tx', `HOME G28 ${axes}`);

    if (window.pywebview && window.pywebview.api && window.pywebview.api.home) {
      try {
        return await window.pywebview.api.home(axes);
      } catch (e) {}
    }

    if (this.mode === 'http') {
      try {
        const res = await fetch(`${this.httpBaseUrl}/api/home`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ axes })
        });
        return await res.json();
      } catch (e) {}
    }

    await this.sendGcode(`G28 ${axes}`);
  }

  /**
   * Emergency Stop
   */
  async emergencyStop() {
    this._log('err', '!!! ЭКСТРЕННАЯ ОСТАНОВКА (M112) !!!');
    this.isStreaming = false;
    this.streamCancelRequested = true;

    if (window.pywebview && window.pywebview.api && window.pywebview.api.emergency_stop) {
      try { await window.pywebview.api.emergency_stop(); } catch (e) {}
    }

    if (this.mode === 'http') {
      try {
        await fetch(`${this.httpBaseUrl}/api/emergency_stop`, { method: 'POST' });
      } catch (e) {}
    }

    await this.sendGcode('M112');
  }

  /**
   * Streams complete G-code file with progress callback
   */
  async streamGcode(gcodeText, onProgress) {
    if (this.isStreaming) return;
    this.isStreaming = true;
    this.streamPaused = false;
    this.streamCancelRequested = false;

    // 1. Try PyWebView native engine stream
    if (window.pywebview && window.pywebview.api && window.pywebview.api.start_stream) {
      try {
        this._log('info', 'Запуск потоковой передачи через PyWebView Engine...');
        await window.pywebview.api.start_stream(gcodeText, false);
        return;
      } catch (e) {
        this._log('err', `PyWebView stream error: ${e}`);
      }
    }

    // 2. Try HTTP API background stream
    if (this.mode === 'http') {
      try {
        this._log('info', 'Запуск потоковой передачи через HTTP Engine...');
        const res = await fetch(`${this.httpBaseUrl}/api/stream/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gcode: gcodeText, binaryMode: false })
        });
        if (res.ok) {
          return;
        }
      } catch (e) {
        this._log('err', `HTTP stream start error: ${e}`);
      }
    }

    // 3. Client-side streaming loop line-by-line (Web Serial or Simulated)
    const lines = gcodeText.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith(';'));

    const total = lines.length;
    this._log('info', `Начало потоковой отправки ${total} команд на MOOZ...`);

    for (let i = 0; i < total; i++) {
      if (this.streamCancelRequested) {
        this._log('err', 'Отправка отменена');
        break;
      }

      while (this.streamPaused) {
        await new Promise(r => setTimeout(r, 200));
        if (this.streamCancelRequested) break;
      }

      const line = lines[i];
      await this.sendGcode(line);

      const percent = Math.round(((i + 1) / total) * 100);
      const prog = {
        isStreaming: true,
        isPaused: false,
        currentLine: i + 1,
        totalLines: total,
        progressPercent: percent,
        lastCommand: line
      };

      if (onProgress) onProgress(prog);
      if (this.onProgressUpdate) this.onProgressUpdate(prog);

      // Pacing delay
      await new Promise(r => setTimeout(r, 12));
    }

    this.isStreaming = false;
    this._log('info', 'Отправка G-code успешно завершена!');
  }

  async pauseStream() {
    this.streamPaused = true;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.pause_stream) {
      try { await window.pywebview.api.pause_stream(); } catch (e) {}
    }
    if (this.mode === 'http') {
      try { await fetch(`${this.httpBaseUrl}/api/stream/pause`, { method: 'POST' }); } catch (e) {}
    }
    this._log('info', 'Поток G-code приостановлен');
  }

  async resumeStream() {
    this.streamPaused = false;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.resume_stream) {
      try { await window.pywebview.api.resume_stream(); } catch (e) {}
    }
    if (this.mode === 'http') {
      try { await fetch(`${this.httpBaseUrl}/api/stream/resume`, { method: 'POST' }); } catch (e) {}
    }
    this._log('info', 'Поток G-code возобновлен');
  }

  async cancelStream() {
    this.streamCancelRequested = true;
    this.isStreaming = false;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.stop_stream) {
      try { await window.pywebview.api.stop_stream(); } catch (e) {}
    }
    if (this.mode === 'http') {
      try { await fetch(`${this.httpBaseUrl}/api/stream/stop`, { method: 'POST' }); } catch (e) {}
    }
    this._log('err', 'Отмена потока G-code');
  }

  _notifyStatus() {
    if (this.onStatusChange) {
      this.onStatusChange({
        connected: this.isConnected,
        port: this.currentPort,
        baud: this.baudRate,
        mode: this.mode
      });
    }
  }

  async _readSerialLoop() {
    while (this.serialPort && this.serialPort.readable && this.isConnected) {
      this.serialReader = this.serialPort.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.serialReader.read();
          if (done) break;
          if (value) {
            const parsed = parseMoozData(value);
            if (parsed) {
              if (parsed.type === 'pose' && this.onPositionUpdate) {
                this.onPositionUpdate(parsed);
              } else if (parsed.type === 'text') {
                this._log('rx', parsed.text);
              }
            }
          }
        }
      } catch (err) {
        console.error('Serial read loop error:', err);
      } finally {
        if (this.serialReader) {
          this.serialReader.releaseLock();
        }
      }
    }
  }

  _startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      if (!this.isConnected) return;

      // 1. PyWebView status query
      if (window.pywebview && window.pywebview.api && window.pywebview.api.get_status) {
        try {
          const st = await window.pywebview.api.get_status();
          if (st) {
            if (st.machine && this.onPositionUpdate) {
              this.onPositionUpdate(st.machine);
            }
            if (st.stream && st.stream.isStreaming) {
              this.isStreaming = true;
              if (this.onProgressUpdate) this.onProgressUpdate(st.stream);
            } else if (this.isStreaming && st.stream && !st.stream.isStreaming) {
              this.isStreaming = false;
              if (this.onProgressUpdate) this.onProgressUpdate(st.stream);
            }
          }
        } catch (e) {}
        return;
      }

      // 2. HTTP Server status query
      if (this.mode === 'http') {
        try {
          const res = await fetch(`${this.httpBaseUrl}/api/status`);
          if (res.ok) {
            const st = await res.json();
            if (st.machine && this.onPositionUpdate) {
              this.onPositionUpdate(st.machine);
            }
            if (st.stream && st.stream.isStreaming) {
              this.isStreaming = true;
              if (this.onProgressUpdate) this.onProgressUpdate(st.stream);
            } else if (this.isStreaming && st.stream && !st.stream.isStreaming) {
              this.isStreaming = false;
              if (this.onProgressUpdate) this.onProgressUpdate(st.stream);
            }
          }
        } catch (e) {}
      }
    }, 1000);
  }
}
