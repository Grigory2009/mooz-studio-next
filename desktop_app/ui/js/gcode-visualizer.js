/**
 * Interactive 2D & 3D Isometric G-code Toolpath Visualizer & Simulator
 * Reverse engineered for Dobot MOOZ 1/2/3
 * 100% Offline & Pure JS Canvas
 */

export class GcodeVisualizer {
  constructor(canvasElement, bedDimensions = { width: 130, depth: 130, height: 130, shape: 'rectangular' }) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.bed = bedDimensions;

    // Viewport transform
    this.scale = 2.0;
    this.panX = 0;
    this.panY = 0;
    this.viewMode = '2d'; // '2d' or '3d'
    this.isDragging = false;
    this.lastMouse = { x: 0, y: 0 };

    // Parsed toolpath data
    this.toolpaths = [];
    this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    this.stats = { totalTime: 0, totalCutLength: 0, totalTravelLength: 0, linesCount: 0 };

    // Simulation playback
    this.simulationIndex = 0;
    this.isPlaying = false;
    this.playbackSpeed = 10; // moves per animation frame
    this.animFrameId = null;

    this._setupEvents();
    this.resetView();
  }

  setBedDimensions(width, depth, height, shape = 'rectangular') {
    this.bed = { width, depth, height, shape };
    this.resetView();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.resetView();
  }

  _setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.panX += dx;
      this.panY += dy;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.render();
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const mouseX = e.offsetX;
      const mouseY = e.offsetY;

      // Zoom towards mouse pointer
      this.panX = mouseX - (mouseX - this.panX) * zoomFactor;
      this.panY = mouseY - (mouseY - this.panY) * zoomFactor;
      this.scale = Math.max(0.1, Math.min(30, this.scale * zoomFactor));

      this.render();
    }, { passive: false });
  }

  resetView() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;

    if (this.viewMode === '2d') {
      const bedW = this.bed.width;
      const bedH = this.bed.depth;
      const margin = 40;
      this.scale = Math.min((w - margin * 2) / bedW, (h - margin * 2) / bedH);
      this.panX = (w - bedW * this.scale) / 2;
      this.panY = (h + bedH * this.scale) / 2;
    } else {
      // 3D Isometric View initial placement
      this.scale = Math.min(w, h) / (this.bed.width * 2.2);
      this.panX = w / 2;
      this.panY = h * 0.72;
    }
    this.render();
  }

  zoomIn() {
    this.scale = Math.min(30, this.scale * 1.25);
    this.render();
  }

  zoomOut() {
    this.scale = Math.max(0.1, this.scale * 0.8);
    this.render();
  }

  /**
   * Parses G-code text and extracts all coordinates and toolpaths
   */
  loadGcode(gcodeText) {
    this.toolpaths = [];
    this.simulationIndex = 0;
    this.stopSimulation();

    if (!gcodeText) {
      this.render();
      return;
    }

    const lines = gcodeText.split('\n');
    let curX = 0;
    let curY = 0;
    let curZ = 0;
    let curS = 0;
    let curF = 1500;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let cutLength = 0;
    let travelLength = 0;
    let estTimeSec = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith(';')) continue;

      const upper = line.toUpperCase();
      const isG0 = upper.includes('G0') || upper.includes('G00');
      const isG1 = upper.includes('G1') || upper.includes('G01');
      const isG28 = upper.includes('G28');

      if (isG28) {
        curX = 0;
        curY = 0;
        curZ = 0;
        continue;
      }

      if (!isG0 && !isG1) {
        const matchF = upper.match(/F([0-9.]+)/);
        if (matchF) curF = parseFloat(matchF[1]);
        const matchS = upper.match(/S([0-9.]+)/);
        if (matchS) curS = parseFloat(matchS[1]);
        continue;
      }

      let nextX = curX;
      let nextY = curY;
      let nextZ = curZ;
      let nextS = curS;
      let nextF = curF;

      const matchX = upper.match(/X(-?[0-9.]+)/);
      const matchY = upper.match(/Y(-?[0-9.]+)/);
      const matchZ = upper.match(/Z(-?[0-9.]+)/);
      const matchS = upper.match(/S([0-9.]+)/);
      const matchF = upper.match(/F([0-9.]+)/);

      if (matchX) nextX = parseFloat(matchX[1]);
      if (matchY) nextY = parseFloat(matchY[1]);
      if (matchZ) nextZ = parseFloat(matchZ[1]);
      if (matchS) nextS = parseFloat(matchS[1]);
      if (matchF) nextF = parseFloat(matchF[1]);

      if (nextX !== curX || nextY !== curY || nextZ !== curZ) {
        const dist = Math.hypot(nextX - curX, nextY - curY, nextZ - curZ);
        const isCut = !isG0 && (nextS > 0 || nextZ < 0);

        if (isCut) {
          cutLength += dist;
        } else {
          travelLength += dist;
        }

        estTimeSec += dist / (Math.max(100, nextF) / 60);

        minX = Math.min(minX, curX, nextX);
        maxX = Math.max(maxX, curX, nextX);
        minY = Math.min(minY, curY, nextY);
        maxY = Math.max(maxY, curY, nextY);
        minZ = Math.min(minZ, curZ, nextZ);
        maxZ = Math.max(maxZ, curZ, nextZ);

        this.toolpaths.push({
          type: isCut ? 'cut' : 'travel',
          from: { x: curX, y: curY, z: curZ },
          to: { x: nextX, y: nextY, z: nextZ },
          power: nextS,
          feed: nextF,
          dist
        });
      }

      curX = nextX;
      curY = nextY;
      curZ = nextZ;
      curS = nextS;
      curF = nextF;
    }

    this.bounds = {
      minX: minX === Infinity ? 0 : minX,
      maxX: maxX === -Infinity ? 0 : maxX,
      minY: minY === Infinity ? 0 : minY,
      maxY: maxY === -Infinity ? 0 : maxY,
      minZ: minZ === Infinity ? 0 : minZ,
      maxZ: maxZ === -Infinity ? 0 : maxZ
    };

    this.stats = {
      totalTime: estTimeSec,
      totalCutLength: cutLength,
      totalTravelLength: travelLength,
      linesCount: this.toolpaths.length
    };

    this.simulationIndex = this.toolpaths.length;
    this.resetView();
  }

  // Coordinate transforms
  _toScreen(x, y, z = 0) {
    if (this.viewMode === '2d') {
      return {
        x: this.panX + x * this.scale,
        y: this.panY - y * this.scale
      };
    } else {
      // Isometric projection
      // Iso angle ~30 deg: cos(30)=0.866, sin(30)=0.5
      const cos30 = 0.866;
      const sin30 = 0.5;
      const isoX = (x - y) * cos30;
      const isoY = (x + y) * sin30 - z * 1.5;
      return {
        x: this.panX + isoX * this.scale,
        y: this.panY - isoY * this.scale
      };
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;

    // Graphite bed canvas background
    ctx.fillStyle = '#141415';
    ctx.fillRect(0, 0, w, h);

    // Draw Machine Bed
    this._drawBed(ctx);

    // Draw Toolpaths up to simulationIndex
    const count = Math.min(this.toolpaths.length, this.simulationIndex);
    for (let i = 0; i < count; i++) {
      const seg = this.toolpaths[i];
      const p1 = this._toScreen(seg.from.x, seg.from.y, seg.from.z);
      const p2 = this._toScreen(seg.to.x, seg.to.y, seg.to.z);

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);

      if (seg.type === 'travel') {
        ctx.strokeStyle = 'rgba(133, 133, 139, 0.35)'; // Steel travel faint dashed
        ctx.lineWidth = Math.max(1, 0.8 * (this.scale / 2));
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
        if (seg.to.z < 0) {
          // CNC Carving: depth colored gradient (ember to deep bronze)
          const depthRatio = Math.min(1, Math.abs(seg.to.z) / Math.max(1, Math.abs(this.bounds.minZ)));
          const hue = 25 + depthRatio * 15; // 25 (ember) to 40
          const light = 60 - depthRatio * 20;
          ctx.strokeStyle = `hsl(${hue}, 85%, ${light}%)`;
          ctx.lineWidth = Math.max(1.2, 1.4 * (this.scale / 2));
        } else {
          // Laser: power color (ember accent)
          const p = seg.power > 0 ? seg.power / 255 : 0.8;
          ctx.strokeStyle = `rgba(249, 115, 22, ${Math.max(0.4, p)})`;
          ctx.lineWidth = Math.max(1, 1.2 * (this.scale / 2));
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Draw Active Toolhead / Laser Cursor
    if (count > 0 && count <= this.toolpaths.length) {
      const lastSeg = this.toolpaths[count - 1];
      const curPos = this._toScreen(lastSeg.to.x, lastSeg.to.y, lastSeg.to.z);
      
      // Cursor ring
      ctx.beginPath();
      ctx.arc(curPos.x, curPos.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(249, 115, 22, 0.35)';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ededed';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(curPos.x, curPos.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // Draw Origin (0,0,0)
    const origin = this._toScreen(0, 0, 0);
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#4cc38a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#4cc38a';
    ctx.fill();

    // Axis indicator
    this._drawAxisGizmo(ctx);
  }

  _drawBed(ctx) {
    const isRound = this.bed.shape === 'circular';

    if (this.viewMode === '2d') {
      if (isRound) {
        // Delta circular bed (radius = width / 2)
        const center = this._toScreen(this.bed.width / 2, this.bed.depth / 2);
        const radius = (this.bed.width / 2) * this.scale;

        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#19191b';
        ctx.fill();
        ctx.strokeStyle = 'rgba(237, 237, 237, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Rings every 10mm
        ctx.strokeStyle = 'rgba(237, 237, 237, 0.04)';
        ctx.lineWidth = 0.5;
        for (let r = 10; r < this.bed.width / 2; r += 10) {
          ctx.beginPath();
          ctx.arc(center.x, center.y, r * this.scale, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        // Rectangular bed
        const p0 = this._toScreen(0, this.bed.depth);
        const w = this.bed.width * this.scale;
        const h = this.bed.depth * this.scale;

        ctx.fillStyle = '#19191b';
        ctx.fillRect(p0.x, p0.y, w, h);
        ctx.strokeStyle = 'rgba(237, 237, 237, 0.12)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p0.x, p0.y, w, h);

        // Grid lines (10mm intervals)
        ctx.strokeStyle = 'rgba(237, 237, 237, 0.04)';
        ctx.lineWidth = 0.5;
        for (let x = 10; x < this.bed.width; x += 10) {
          const start = this._toScreen(x, 0);
          const end = this._toScreen(x, this.bed.depth);
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
        for (let y = 10; y < this.bed.depth; y += 10) {
          const start = this._toScreen(0, y);
          const end = this._toScreen(this.bed.width, y);
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }
    } else {
      // 3D Isometric Bed
      const p00 = this._toScreen(0, 0, 0);
      const p10 = this._toScreen(this.bed.width, 0, 0);
      const p11 = this._toScreen(this.bed.width, this.bed.depth, 0);
      const p01 = this._toScreen(0, this.bed.depth, 0);

      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fillStyle = '#19191b';
      ctx.fill();
      ctx.strokeStyle = 'rgba(237, 237, 237, 0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 3D Grid lines
      ctx.strokeStyle = 'rgba(237, 237, 237, 0.04)';
      ctx.lineWidth = 0.5;
      for (let x = 10; x < this.bed.width; x += 10) {
        const start = this._toScreen(x, 0, 0);
        const end = this._toScreen(x, this.bed.depth, 0);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
      for (let y = 10; y < this.bed.depth; y += 10) {
        const start = this._toScreen(0, y, 0);
        const end = this._toScreen(this.bed.width, y, 0);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
    }
  }

  _drawAxisGizmo(ctx) {
    const origin = this._toScreen(0, 0, 0);
    const len = 24;

    // X Axis
    const xEnd = this._toScreen(len / this.scale, 0, 0);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(xEnd.x, xEnd.y);
    ctx.strokeStyle = '#e5484d';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Y Axis
    const yEnd = this._toScreen(0, len / this.scale, 0);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(yEnd.x, yEnd.y);
    ctx.strokeStyle = '#4cc38a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Z Axis (in 3D mode)
    if (this.viewMode === '3d') {
      const zEnd = this._toScreen(0, 0, len / this.scale);
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(zEnd.x, zEnd.y);
      ctx.strokeStyle = '#85858b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Simulation controls
  startSimulation(onStep) {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (this.simulationIndex >= this.toolpaths.length) {
      this.simulationIndex = 0;
    }

    const loop = () => {
      if (!this.isPlaying) return;
      this.simulationIndex = Math.min(this.toolpaths.length, this.simulationIndex + this.playbackSpeed);
      this.render();
      if (onStep) {
        onStep(this.simulationIndex, this.toolpaths.length);
      }
      if (this.simulationIndex < this.toolpaths.length) {
        this.animFrameId = requestAnimationFrame(loop);
      } else {
        this.isPlaying = false;
      }
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  pauseSimulation() {
    this.isPlaying = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }

  stopSimulation() {
    this.isPlaying = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.simulationIndex = this.toolpaths.length;
    this.render();
  }

  setSimulationProgress(ratio) {
    this.simulationIndex = Math.round(ratio * this.toolpaths.length);
    this.render();
  }
}
