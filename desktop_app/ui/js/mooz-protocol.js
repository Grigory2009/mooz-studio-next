/**
 * Dobot MOOZ Serial / WiFi Binary Protocol Implementation
 * Reverse engineered from MOOZ Studio 2.3.2-beta
 * 100% Offline & Pure JS
 */

const CRC8_TABLE = [
  0,7,14,9,28,27,18,21,56,63,54,49,36,35,42,45,112,119,126,121,108,107,98,101,72,79,70,65,84,83,90,93,
  224,231,238,233,252,251,242,245,216,223,214,209,196,195,202,205,144,151,158,153,140,139,130,133,168,175,166,161,180,179,186,189,
  199,192,201,206,219,220,213,210,255,248,241,246,227,228,237,234,183,176,185,190,171,172,165,162,143,136,129,134,147,148,157,154,
  39,32,41,46,59,60,53,50,31,24,17,22,3,4,13,10,87,80,89,94,75,76,69,66,111,104,97,102,115,116,125,122,
  137,142,135,128,149,146,155,156,177,182,191,184,173,170,163,164,249,254,247,240,229,226,235,236,193,198,207,200,221,218,211,212,
  105,110,103,96,117,114,123,124,81,86,95,88,77,74,67,68,25,30,23,16,5,2,11,12,33,38,47,40,61,58,51,52,
  78,73,64,71,82,85,92,91,118,113,120,127,106,109,100,99,62,57,48,55,34,37,44,43,6,1,8,15,26,29,20,19,
  174,169,160,167,178,181,188,187,150,145,152,159,138,141,132,131,222,217,208,215,194,197,204,203,230,225,232,239,250,253,244,243
];

export function crc8Atm(uint8Array) {
  let crc = 0;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = CRC8_TABLE[(crc ^ uint8Array[i]) & 0xFF];
  }
  return crc & 0xFF;
}

export function crc16Ibm(uint8Array) {
  let crc = 0x0000;
  for (let i = 0; i < uint8Array.length; i++) {
    crc ^= uint8Array[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xA001;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xFFFF;
}

export const MoozCmd = {
  GCODE: 0,
  FLAT: 1,
  CURRENT_POS: 2,
  CURRENT_TEMP: 3,
  CURRENT_POWER: 4,
  END_STOP_TYPE: 5,
  RUNNING: 6,
  FILE_TRANSFER_SETTING: 22,
  TRANSFER_GCODE: 23,
  TRANSFER_VERIFY: 24,
  VERIFY_FILE_GROUP: 25,
  SET_CLIENT: 36
};

let seqCounter = 1;

/**
 * Packs a message for Dobot MOOZ
 * @param {Uint8Array|string|null} payload - Payload data (string or bytes)
 * @param {number} cmdId - Command ID from MoozCmd
 * @returns {Uint8Array} Total framed binary packet
 */
export function buildMoozPacket(payload, cmdId) {
  let payloadBytes = null;
  if (typeof payload === 'string') {
    payloadBytes = new TextEncoder().encode(payload);
  } else if (payload instanceof Uint8Array) {
    payloadBytes = payload;
  }

  const payloadLen = payloadBytes ? payloadBytes.length : 0;
  const HEAD_LEN = 14;
  const headerBuf = new Uint8Array(HEAD_LEN);
  const view = new DataView(headerBuf.buffer);

  // Magic header 0xAA 0xBB
  headerBuf[0] = 0xAA;
  headerBuf[1] = 0xBB;
  // Payload length (uint16 LE)
  view.setUint16(2, payloadLen, true);
  // Protocol Version 0x10, Config 0x14
  headerBuf[4] = 0x10;
  headerBuf[5] = 0x14;
  // Sequence number (uint32 LE)
  view.setUint32(6, seqCounter++, true);
  // Source (0x00 = PC), Destination (0x10 = MOOZ)
  headerBuf[10] = 0x00;
  headerBuf[11] = 0x10;
  // Command set (0x04 = MOOZ standard)
  headerBuf[12] = 0x04;
  // Command ID
  headerBuf[13] = cmdId;

  // Header CRC8
  const headCrc = crc8Atm(headerBuf);

  // Packet buffer = header (14) + crc8 (1) + payload (N)
  const packetBuf = new Uint8Array(HEAD_LEN + 1 + payloadLen);
  packetBuf.set(headerBuf, 0);
  packetBuf[HEAD_LEN] = headCrc;
  if (payloadBytes && payloadLen > 0) {
    packetBuf.set(payloadBytes, HEAD_LEN + 1);
  }

  // Packet CRC16-IBM (2 bytes LE)
  const packetCrc = crc16Ibm(packetBuf);

  // Final buffer = packetBuf + crc16 (2 bytes)
  const totalBuf = new Uint8Array(packetBuf.length + 2);
  totalBuf.set(packetBuf, 0);
  const totalView = new DataView(totalBuf.buffer);
  totalView.setUint16(packetBuf.length, packetCrc, true);

  return totalBuf;
}

/**
 * Creates G-code packet ready to transmit over serial
 */
export function buildGcodePacket(gcodeLine) {
  const line = gcodeLine.trim() + '\n';
  return buildMoozPacket(line, MoozCmd.GCODE);
}

/**
 * Parses raw data incoming from MOOZ
 */
export function parseMoozData(buffer) {
  if (buffer.length < 17) return null; // Min packet length with empty payload
  if (buffer[0] !== 0xAA || buffer[1] !== 0xBB) return null;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const payloadLen = view.getUint16(2, true);
  if (buffer.length < 17 + payloadLen) return null; // Incomplete packet

  const cmdId = buffer[13];
  const payloadOffset = 15; // 14 head + 1 crc8
  const payload = buffer.subarray(payloadOffset, payloadOffset + payloadLen);

  switch (cmdId) {
    case MoozCmd.CURRENT_POS: { // [x, y, z, e] 4 floats
      if (payload.length >= 16) {
        const pView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        return {
          type: 'pose',
          x: pView.getFloat32(0, true),
          y: pView.getFloat32(4, true),
          z: pView.getFloat32(8, true),
          e: pView.getFloat32(12, true)
        };
      }
      break;
    }
    case MoozCmd.CURRENT_TEMP: { // [hotend, bed] floats
      if (payload.length >= 8) {
        const tView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        return {
          type: 'temp',
          hotend: tView.getFloat32(0, true),
          bed: tView.getFloat32(4, true)
        };
      }
      break;
    }
    case MoozCmd.RUNNING: {
      return {
        type: 'running',
        running: payload[0] === 1
      };
    }
  }

  // Fallback ASCII / text response
  try {
    const text = new TextDecoder().decode(payload);
    return { type: 'text', cmdId, text };
  } catch (e) {
    return { type: 'raw', cmdId, payload };
  }
}
