import { buildMoozPacket, buildGcodePacket, parseMoozData, crc8Atm, crc16Ibm } from './ui/js/mooz-protocol.js';
import { LaserGenerator } from './ui/js/laser-generator.js';
import { CncGenerator } from './ui/js/cnc-generator.js';
import { CURA_PROFILES } from './ui/js/cura-data.js';

console.log('=== TESTING MOOZ STUDIO NEXT FRONTEND MODULES ===\n');

// 1. Test Protocol
console.log('1. Testing Protocol & CRCs...');
const testBytes = new Uint8Array([0xAA, 0xBB, 0x01, 0x02, 0x03]);
const crc8 = crc8Atm(testBytes);
const crc16 = crc16Ibm(testBytes);
console.log(`- CRC8: 0x${crc8.toString(16)} (expected valid uint8)`);
console.log(`- CRC16: 0x${crc16.toString(16)} (expected valid uint16)`);

const packet = buildGcodePacket('G28');
if (packet[0] === 0xAA && packet[1] === 0xBB) {
  console.log(`- Magic header: 0xAA 0xBB verified (packet length: ${packet.length})`);
} else {
  throw new Error('Magic header mismatch');
}

// 2. Test Laser Generator
console.log('\n2. Testing Laser CAM Generator...');
const dummyImageData = {
  width: 20,
  height: 20,
  data: new Uint8ClampedArray(20 * 20 * 4)
};
// Fill half black (burn), half white
for (let i = 0; i < 20 * 20; i++) {
  const val = i < 200 ? 0 : 255;
  dummyImageData.data[i * 4] = val;
  dummyImageData.data[i * 4 + 1] = val;
  dummyImageData.data[i * 4 + 2] = val;
  dummyImageData.data[i * 4 + 3] = 255;
}

const laser = new LaserGenerator({
  engravingSpeed: 1500,
  travelSpeed: 3000,
  powerMax: 100,
  powerMin: 0,
  mode: 'floyd',
  targetWidth: 50,
  targetHeight: 50,
  border: 1
});
const laserResult = laser.generateFromImageData(dummyImageData);
console.log(`- Laser G-code generated: ${laserResult.linesCount} lines, estimated ${laserResult.estimatedTimeMinutes} min`);
if (!laserResult.gcode.includes('G28') || !laserResult.gcode.includes('M106 S0')) {
  throw new Error('Laser G-code missing required Dobot commands');
}

// 3. Test CNC Generator
console.log('\n3. Testing CNC Carving Generator...');
const cnc = new CncGenerator({
  cncSpeed: 600,
  plungeSpeed: 200,
  totalDepth: 2.0,
  stepDepth: 1.0,
  safeHeight: 5.0,
  spindleSpeed: 12000,
  targetWidth: 30,
  targetHeight: 30
});
const cncResult = cnc.generateRelief(dummyImageData);
console.log(`- CNC G-code generated: ${cncResult.linesCount} lines, estimated ${cncResult.estimatedTimeMinutes} min`);
if (!cncResult.gcode.includes('M3 S12000') || !cncResult.gcode.includes('M5')) {
  throw new Error('CNC G-code missing spindle control commands');
}

// 4. Test Cura Profiles Data
console.log('\n4. Testing Cura Profiles Data...');
const mooz1 = CURA_PROFILES['mooz-1-2'];
const mooz2p = CURA_PROFILES['mooz-2-plus'];
const mooz3 = CURA_PROFILES['mooz-3'];
console.log(`- MOOZ-1/2: ${mooz1.width}x${mooz1.depth}x${mooz1.height} mm, Bed: ${mooz1.heatedBed}`);
console.log(`- MOOZ-2 PLUS: ${mooz2p.width}x${mooz2p.depth}x${mooz2p.height} mm`);
console.log(`- MOOZ-3 Delta: Ø ${mooz3.width} mm, Shape: ${mooz3.shape}`);

console.log('\n>>> ALL FRONTEND MODULE TESTS PASSED (100%) <<<');
