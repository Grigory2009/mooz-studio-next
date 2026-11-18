/**
 * Dobot MOOZ CNC Carving & 2.5D Relief G-code Generator
 * Reverse engineered from MOOZ Studio CNC Module
 * 100% Offline & Pure JS
 */

export class CncGenerator {
  constructor(options = {}) {
    this.cncSpeed = options.cncSpeed || 600;            // mm/min cutting feedrate
    this.plungeSpeed = options.plungeSpeed || 200;      // mm/min Z plunge feedrate
    this.travelSpeed = options.travelSpeed || 1500;     // mm/min rapid travel
    this.spindleSpeed = options.spindleSpeed || 12000;  // Spindle RPM (M3 S...)
    this.safeHeight = options.safeHeight || 5.0;        // mm (Z clearance above stock)
    this.totalDepth = options.totalDepth || 2.0;        // mm (Max carving depth Z-)
    this.stepDepth = options.stepDepth || 0.5;          // mm (Z step-down per pass)
    this.toolType = options.toolType || 'vBit';         // 'vBit', 'flatMill', 'ballNose'
    this.toolDiameter = options.toolDiameter || 3.175;  // mm
    this.vBitAngle = options.vBitAngle || 30;           // degrees
    this.targetWidth = options.targetWidth || 50;       // mm
    this.targetHeight = options.targetHeight || 50;     // mm
    this.originX = options.originX || 0;
    this.originY = options.originY || 0;
    this.invert = options.invert || false;              // Darker = deeper vs Lighter = deeper
  }

  /**
   * Generates 2.5D Relief G-code from an image heightmap
   * @param {ImageData} imageData 
   * @returns {{ gcode: string, estimatedTimeMinutes: number, linesCount: number }}
   */
  generateRelief(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    // Build normalized depth map (0.0 = surface, 1.0 = maximum depth)
    const depthMap = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3] / 255;

      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a < 0.5) gray = 255;
      if (this.invert) gray = 255 - gray;

      // Dark pixels (0) = deep cut (1.0), White pixels (255) = no cut (0.0)
      depthMap[i] = Math.max(0, Math.min(1.0, (255 - gray) / 255));
    }

    const gcode = [];
    let timeSeconds = 0;

    const numPasses = Math.max(1, Math.ceil(this.totalDepth / this.stepDepth));
    const pixelSizeX = this.targetWidth / width;
    const pixelSizeY = this.targetHeight / height;

    gcode.push('; Dobot MOOZ CNC Relief Carving G-code');
    gcode.push(`; Tool: ${this.toolType} (Diameter: ${this.toolDiameter} mm, Angle: ${this.vBitAngle}°)`);
    gcode.push(`; Dimensions: ${this.targetWidth.toFixed(1)} x ${this.targetHeight.toFixed(1)} mm`);
    gcode.push(`; Max Depth: -${this.totalDepth.toFixed(2)} mm in ${numPasses} passes (Step: ${this.stepDepth.toFixed(2)} mm)`);
    gcode.push(`; Feeds: Cut ${this.cncSpeed} mm/min, Plunge ${this.plungeSpeed} mm/min, Travel ${this.travelSpeed} mm/min`);
    gcode.push(`; Spindle: ${this.spindleSpeed} RPM`);
    
    // Safety & Setup
    gcode.push('G21 ; Metric units (mm)');
    gcode.push('G90 ; Absolute coordinates');
    gcode.push('G28 ; Home axes');
    gcode.push(`G0 Z${this.safeHeight.toFixed(2)} F${this.travelSpeed}`);
    gcode.push(`M3 S${this.spindleSpeed} ; Start spindle`);
    gcode.push('G4 P2 ; Dwell 2 seconds for spindle ramp-up');

    let curX = 0;
    let curY = 0;
    let curZ = this.safeHeight;

    // Multi-pass depth carving
    for (let pass = 1; pass <= numPasses; pass++) {
      const currentMaxPassDepth = Math.min(this.totalDepth, pass * this.stepDepth);
      gcode.push(`; --- PASS ${pass}/${numPasses} (Max Z: -${currentMaxPassDepth.toFixed(2)}mm) ---`);

      for (let y = 0; y < height; y++) {
        const isReverse = (y % 2 === 1);
        const rowY = this.originY + (height - 1 - y) * pixelSizeY;

        const startX = isReverse ? width - 1 : 0;
        const endX = isReverse ? -1 : width;
        const stepX = isReverse ? -1 : 1;

        let inCut = false;

        for (let x = startX; x !== endX; x += stepX) {
          const depthRatio = depthMap[y * width + x];
          const targetZ = -(depthRatio * currentMaxPassDepth);
          const posX = this.originX + x * pixelSizeX;

          if (depthRatio > 0.04) {
            // Cut area
            if (!inCut) {
              // Rapid move above stock
              gcode.push(`G0 X${posX.toFixed(2)} Y${rowY.toFixed(2)} Z${this.safeHeight.toFixed(2)} F${this.travelSpeed}`);
              // Plunge down
              gcode.push(`G1 Z${targetZ.toFixed(3)} F${this.plungeSpeed}`);
              timeSeconds += (this.safeHeight - targetZ) / (this.plungeSpeed / 60);
              inCut = true;
            } else {
              // Continuous 3D milling move
              gcode.push(`G1 X${posX.toFixed(2)} Y${rowY.toFixed(2)} Z${targetZ.toFixed(3)} F${this.cncSpeed}`);
              const dist = Math.hypot(posX - curX, rowY - curY, targetZ - curZ);
              timeSeconds += dist / (this.cncSpeed / 60);
            }
          } else {
            // Clearance area
            if (inCut) {
              // Retract tool to safety plane
              gcode.push(`G0 Z${this.safeHeight.toFixed(2)} F${this.travelSpeed}`);
              timeSeconds += (this.safeHeight - curZ) / (this.travelSpeed / 60);
              inCut = false;
            }
          }

          curX = posX;
          curY = rowY;
          curZ = inCut ? targetZ : this.safeHeight;
        }

        if (inCut) {
          gcode.push(`G0 Z${this.safeHeight.toFixed(2)} F${this.travelSpeed}`);
          timeSeconds += (this.safeHeight - curZ) / (this.travelSpeed / 60);
          curZ = this.safeHeight;
        }
      }
    }

    // End sequence
    gcode.push(`G0 Z${this.safeHeight.toFixed(2)} F${this.travelSpeed}`);
    gcode.push('M5 ; Spindle Stop');
    gcode.push('G0 X0 Y0 F3000');
    gcode.push('G28 ; Home');

    return {
      gcode: gcode.join('\n'),
      estimatedTimeMinutes: Math.max(0.1, Math.round((timeSeconds / 60) * 10) / 10),
      linesCount: gcode.length
    };
  }
}
