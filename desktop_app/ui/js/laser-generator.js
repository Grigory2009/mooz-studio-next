/**
 * Dobot MOOZ Laser Engraver G-code Generator
 * Reverse engineered from MOOZ Studio + Advanced Dithering & Grayscale Algorithms
 * 100% Offline & Pure JS
 */

export class LaserGenerator {
  constructor(options = {}) {
    this.engravingSpeed = options.engravingSpeed || 1500; // mm/min (F)
    this.travelSpeed = options.travelSpeed || 3000;       // mm/min (F)
    this.powerMin = options.powerMin !== undefined ? options.powerMin : 0;     // % (0-100)
    this.powerMax = options.powerMax !== undefined ? options.powerMax : 100;   // % (0-100)
    this.mode = options.mode || 'gray';                   // 'gray', 'floyd', 'atkinson', 'binary'
    this.threshold = options.threshold || 128;
    this.invert = options.invert || false;
    this.flipX = options.flipX || false;
    this.flipY = options.flipY || false;
    this.border = options.border || 0;                    // border passes
    this.originX = options.originX || 0;                  // mm
    this.originY = options.originY || 0;                  // mm
    this.targetWidth = options.targetWidth || 50;         // mm
    this.targetHeight = options.targetHeight || 50;       // mm
  }

  /**
   * Applies Floyd-Steinberg dithering in-place to grayscale float buffer
   */
  _applyFloydSteinberg(gray, width, height) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldPixel = gray[idx];
        const newPixel = oldPixel < this.threshold ? 0 : 255;
        gray[idx] = newPixel;
        const quantError = oldPixel - newPixel;

        if (x + 1 < width) {
          gray[y * width + (x + 1)] += quantError * (7 / 16);
        }
        if (x - 1 >= 0 && y + 1 < height) {
          gray[(y + 1) * width + (x - 1)] += quantError * (3 / 16);
        }
        if (y + 1 < height) {
          gray[(y + 1) * width + x] += quantError * (5 / 16);
        }
        if (x + 1 < width && y + 1 < height) {
          gray[(y + 1) * width + (x + 1)] += quantError * (1 / 16);
        }
      }
    }
  }

  /**
   * Applies Atkinson dithering in-place to grayscale float buffer
   */
  _applyAtkinson(gray, width, height) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldPixel = gray[idx];
        const newPixel = oldPixel < this.threshold ? 0 : 255;
        gray[idx] = newPixel;
        const quantError = Math.floor((oldPixel - newPixel) / 8);

        const distribute = (dx, dy) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            gray[ny * width + nx] += quantError;
          }
        };

        distribute(1, 0);
        distribute(2, 0);
        distribute(-1, 1);
        distribute(0, 1);
        distribute(1, 1);
        distribute(0, 2);
      }
    }
  }

  /**
   * Generates G-code from HTML Canvas ImageData
   * @param {ImageData} imageData 
   * @returns {{ gcode: string, estimatedTimeMinutes: number, linesCount: number }}
   */
  generateFromImageData(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    // Convert to 2D grayscale array (0-255: 0 = black/burn, 255 = white/off)
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const srcY = this.flipY ? (height - 1 - y) : y;
      for (let x = 0; x < width; x++) {
        const srcX = this.flipX ? (width - 1 - x) : x;
        const idx = (srcY * width + srcX) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3] / 255;

        // Perceptual luminance formula
        let val = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a < 0.5) val = 255; // transparent is treated as white
        if (this.invert) val = 255 - val;
        gray[y * width + x] = Math.max(0, Math.min(255, val));
      }
    }

    if (this.mode === 'floyd') {
      this._applyFloydSteinberg(gray, width, height);
    } else if (this.mode === 'atkinson') {
      this._applyAtkinson(gray, width, height);
    }

    const gcode = [];
    let printTimeSeconds = 0;

    // MOOZ Laser Start Sequence
    gcode.push('; Dobot MOOZ Laser Engraving G-code');
    gcode.push(`; Size: ${this.targetWidth.toFixed(1)} x ${this.targetHeight.toFixed(1)} mm`);
    gcode.push(`; Resolution: ${width} x ${height} px`);
    gcode.push(`; Speed: ${this.engravingSpeed} mm/min, Travel: ${this.travelSpeed} mm/min`);
    gcode.push(`; Power: Min ${this.powerMin}% - Max ${this.powerMax}%`);
    gcode.push(`; Mode: ${this.mode}`);
    gcode.push('G21 ; Millimeters');
    gcode.push('G90 ; Absolute coordinates');
    gcode.push('G28 ; Home all axes');
    gcode.push('M106 S0 ; Ensure laser off');
    gcode.push(`G1 X0 Y0 Z0 F${this.travelSpeed}`);
    gcode.push(`G0 S0 F${this.travelSpeed}`);

    const pixelSizeX = this.targetWidth / width;
    const pixelSizeY = this.targetHeight / height;

    let curX = 0;
    let curY = 0;

    // Contour Border Passes
    if (this.border > 0) {
      const bPower = Math.round(255 * (this.powerMax / 100));
      for (let b = 0; b < this.border; b++) {
        const x0 = this.originX.toFixed(2);
        const y0 = this.originY.toFixed(2);
        const x1 = (this.originX + this.targetWidth).toFixed(2);
        const y1 = (this.originY + this.targetHeight).toFixed(2);
        gcode.push(`; Border pass ${b + 1}`);
        gcode.push(`G0 X${x0} Y${y0} S0 F${this.travelSpeed}`);
        gcode.push(`G1 X${x1} Y${y0} S${bPower} F${this.engravingSpeed}`);
        gcode.push(`G1 X${x1} Y${y1} S${bPower} F${this.engravingSpeed}`);
        gcode.push(`G1 X${x0} Y${y1} S${bPower} F${this.engravingSpeed}`);
        gcode.push(`G1 X${x0} Y${y0} S${bPower} F${this.engravingSpeed}`);
        printTimeSeconds += (2 * (this.targetWidth + this.targetHeight)) / (this.engravingSpeed / 60);
      }
      gcode.push(`G0 S0 F${this.travelSpeed}`);
    }

    let laserState = 0; // 0 = off, >0 = current power

    // Serpentine raster scanning
    for (let y = 0; y < height; y++) {
      const isReverse = (y % 2 === 1);
      const rowY = this.originY + (height - 1 - y) * pixelSizeY;

      const startX = isReverse ? width - 1 : 0;
      const endX = isReverse ? -1 : width;
      const stepX = isReverse ? -1 : 1;

      for (let x = startX; x !== endX; x += stepX) {
        const val = gray[y * width + x];
        const posX = this.originX + x * pixelSizeX;

        let power = 0;
        if (this.mode === 'gray') {
          // Grayscale: 0 is dark (max burn), 255 is white (laser off)
          const burnVal = 255 - val;
          if (burnVal > 8) {
            const minP = 255 * (this.powerMin / 100);
            const maxP = 255 * (this.powerMax / 100);
            power = Math.round(minP + (burnVal / 255) * (maxP - minP));
            if (power > 255) power = 255;
          }
        } else {
          // Binary or Dithered
          if (val < this.threshold) {
            power = Math.round(255 * (this.powerMax / 100));
          } else {
            power = 0;
          }
        }

        if (power <= 5) {
          // Pixel is white / off
          if (laserState !== 0) {
            gcode.push(`G0 S0 F${this.travelSpeed}`);
            laserState = 0;
          }
        } else {
          // Pixel is active burn
          if (laserState === 0) {
            // Rapid move to position before turning on
            gcode.push(`G0 X${posX.toFixed(2)} Y${rowY.toFixed(2)} S0 F${this.travelSpeed}`);
            const dist = Math.hypot(posX - curX, rowY - curY);
            printTimeSeconds += dist / (this.travelSpeed / 60);
          }
          gcode.push(`G1 X${posX.toFixed(2)} Y${rowY.toFixed(2)} S${power} F${this.engravingSpeed}`);
          const dist = Math.hypot(posX - curX, rowY - curY);
          printTimeSeconds += dist / (this.engravingSpeed / 60);
          laserState = power;
        }

        curX = posX;
        curY = rowY;
      }
    }

    // MOOZ Laser End Sequence
    gcode.push('M106 S0 ; Laser off');
    gcode.push(`G0 S0 F${this.travelSpeed}`);
    gcode.push('G0 X0 Y0 F3000');
    gcode.push('G28 ; Home');

    return {
      gcode: gcode.join('\n'),
      estimatedTimeMinutes: Math.max(0.1, Math.round((printTimeSeconds / 60) * 10) / 10),
      linesCount: gcode.length
    };
  }
}
