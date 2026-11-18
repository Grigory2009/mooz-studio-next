"""
Dobot MOOZ Engine Core — Python Backend
Provides:
  1. Dobot MOOZ binary serial protocol (Header 0xAA 0xBB, CRC8-ATM, CRC16-IBM, Packet builder & parser)
  2. Laser G-code generator (Grayscale PWM S0-255, Floyd-Steinberg, Atkinson, Binary threshold, Serpentine scan)
  3. CNC 2.5D relief depth slicing generator
  4. Serial communication via pyserial (CH340 auto-detect, 115200 baud, jog, G-code streaming with progress)
  5. Local HTTP server / REST JSON API with full CORS support + direct pywebview JS API compatibility
"""

import sys
import os
import time
import math
import json
import base64
import io
import struct
import threading
from typing import Optional, List, Dict, Any, Union, Tuple
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Optional serial support
try:
    import serial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False

# Image processing support
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# ============================================================================
# 1. DOBOT MOOZ BINARY PROTOCOL & CRC
# ============================================================================

CRC8_TABLE = [
    0, 7, 14, 9, 28, 27, 18, 21, 56, 63, 54, 49, 36, 35, 42, 45, 112, 119, 126, 121, 108, 107, 98, 101, 72, 79, 70, 65, 84, 83, 90, 93,
    224, 231, 238, 233, 252, 251, 242, 245, 216, 223, 214, 209, 196, 195, 202, 205, 144, 151, 158, 153, 140, 139, 130, 133, 168, 175, 166, 161, 180, 179, 186, 189,
    199, 192, 201, 206, 219, 220, 213, 210, 255, 248, 241, 246, 227, 228, 237, 234, 183, 176, 185, 190, 171, 172, 165, 162, 143, 136, 129, 134, 147, 148, 157, 154,
    39, 32, 41, 46, 59, 60, 53, 50, 31, 24, 17, 22, 3, 4, 13, 10, 87, 80, 89, 94, 75, 76, 69, 66, 111, 104, 97, 102, 115, 116, 125, 122,
    137, 142, 135, 128, 149, 146, 155, 156, 177, 182, 191, 184, 173, 170, 163, 164, 249, 254, 247, 240, 229, 226, 235, 236, 193, 198, 207, 200, 221, 218, 211, 212,
    105, 110, 103, 96, 117, 114, 123, 124, 81, 86, 95, 88, 77, 74, 67, 68, 25, 30, 23, 16, 5, 2, 11, 12, 33, 38, 47, 40, 61, 58, 51, 52,
    78, 73, 64, 71, 82, 85, 92, 91, 118, 113, 120, 127, 106, 109, 100, 99, 62, 57, 48, 55, 34, 37, 44, 43, 6, 1, 8, 15, 26, 29, 20, 19,
    174, 169, 160, 167, 178, 181, 188, 187, 150, 145, 152, 159, 138, 141, 132, 131, 222, 217, 208, 215, 194, 197, 204, 203, 230, 225, 232, 239, 250, 253, 244, 243
]

def crc8_atm(data: bytes) -> int:
    """Calculate CRC8-ATM over bytes."""
    crc = 0
    for b in data:
        crc = CRC8_TABLE[(crc ^ b) & 0xFF]
    return crc & 0xFF

def crc16_ibm(data: bytes) -> int:
    """Calculate CRC16-IBM (Modbus/polynomial 0xA001) over bytes."""
    crc = 0x0000
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF

class MoozCmd:
    GCODE = 0
    FLAT = 1
    CURRENT_POS = 2
    CURRENT_TEMP = 3
    CURRENT_POWER = 4
    END_STOP_TYPE = 5
    RUNNING = 6
    FILE_TRANSFER_SETTING = 22
    TRANSFER_GCODE = 23
    TRANSFER_VERIFY = 24
    VERIFY_FILE_GROUP = 25
    SET_CLIENT = 36


class MoozProtocol:
    """Dobot MOOZ binary protocol builder and parser."""
    _seq_lock = threading.Lock()
    _seq_counter = 1

    @classmethod
    def get_next_seq(cls) -> int:
        with cls._seq_lock:
            s = cls._seq_counter
            cls._seq_counter = (cls._seq_counter + 1) & 0xFFFFFFFF
            return s

    @staticmethod
    def build_packet(payload: Union[bytes, str, None], cmd_id: int, seq: Optional[int] = None) -> bytes:
        """
        Builds a Dobot MOOZ binary packet:
        [0..1]: Header 0xAA 0xBB (2 bytes)
        [2..3]: Payload length uint16 LE (2 bytes)
        [4]: Protocol version 0x10 (1 byte)
        [5]: Config 0x14 (1 byte)
        [6..9]: Sequence uint32 LE (4 bytes)
        [10]: Source 0x00 (PC) (1 byte)
        [11]: Destination 0x10 (MOOZ) (1 byte)
        [12]: Command Set 0x04 (1 byte)
        [13]: Command ID (1 byte)
        [14]: Header CRC8-ATM (1 byte)
        [15 .. 15+N-1]: Payload bytes (N bytes)
        [15+N .. 15+N+1]: Packet CRC16-IBM LE (2 bytes)
        """
        if payload is None:
            payload_bytes = b''
        elif isinstance(payload, str):
            payload_bytes = payload.encode('utf-8')
        elif isinstance(payload, (bytes, bytearray)):
            payload_bytes = bytes(payload)
        else:
            payload_bytes = bytes(payload)

        payload_len = len(payload_bytes)
        if seq is None:
            seq = MoozProtocol.get_next_seq()

        header = bytearray(14)
        header[0] = 0xAA
        header[1] = 0xBB
        struct.pack_into('<H', header, 2, payload_len)
        header[4] = 0x10  # version
        header[5] = 0x14  # config
        struct.pack_into('<I', header, 6, seq)
        header[10] = 0x00 # src
        header[11] = 0x10 # dst
        header[12] = 0x04 # cmdset
        header[13] = cmd_id & 0xFF

        head_crc = crc8_atm(header)

        packet_buf = bytes(header) + bytes([head_crc]) + payload_bytes
        packet_crc = crc16_ibm(packet_buf)

        full_packet = packet_buf + struct.pack('<H', packet_crc)
        return full_packet

    @staticmethod
    def build_gcode_packet(gcode_line: str) -> bytes:
        """Creates G-code packet ready to transmit over serial."""
        line = gcode_line.strip() + '\n'
        return MoozProtocol.build_packet(line, MoozCmd.GCODE)

    @staticmethod
    def parse_packet(packet_data: bytes) -> Optional[Dict[str, Any]]:
        """Parses a single Dobot MOOZ binary frame."""
        if len(packet_data) < 17:
            return None
        if packet_data[0] != 0xAA or packet_data[1] != 0xBB:
            return None

        payload_len = struct.unpack_from('<H', packet_data, 2)[0]
        total_len = 17 + payload_len
        if len(packet_data) < total_len:
            return None

        head_bytes = packet_data[:14]
        recv_head_crc = packet_data[14]
        calc_head_crc = crc8_atm(head_bytes)
        if recv_head_crc != calc_head_crc:
            return None

        data_and_head = packet_data[:15 + payload_len]
        recv_pkt_crc = struct.unpack_from('<H', packet_data, 15 + payload_len)[0]
        calc_pkt_crc = crc16_ibm(data_and_head)
        if recv_pkt_crc != calc_pkt_crc:
            return None

        ver = packet_data[4]
        cfg = packet_data[5]
        seq = struct.unpack_from('<I', packet_data, 6)[0]
        src = packet_data[10]
        dst = packet_data[11]
        cmdset = packet_data[12]
        cmd_id = packet_data[13]

        payload = packet_data[15:15 + payload_len]
        result: Dict[str, Any] = {
            'seq': seq,
            'src': src,
            'dst': dst,
            'cmdset': cmdset,
            'cmdId': cmd_id,
            'payload_raw': payload.hex(),
            'total_bytes': total_len
        }

        # Decode specific payloads
        if cmd_id == MoozCmd.CURRENT_POS and len(payload) >= 16:
            x, y, z, e = struct.unpack_from('<4f', payload, 0)
            result.update({'type': 'pose', 'x': round(x, 3), 'y': round(y, 3), 'z': round(z, 3), 'e': round(e, 3)})
        elif cmd_id == MoozCmd.CURRENT_TEMP and len(payload) >= 8:
            nozzle, bed = struct.unpack_from('<2f', payload, 0)
            result.update({'type': 'temp', 'nozzle': round(nozzle, 1), 'bed': round(bed, 1)})
        elif cmd_id == MoozCmd.RUNNING and len(payload) >= 1:
            result.update({'type': 'running', 'isRunning': (payload[0] == 1)})
        elif cmd_id == MoozCmd.GCODE:
            result.update({'type': 'gcode_ack', 'success': True})
        else:
            result.update({'type': 'raw', 'payload': payload.decode('utf-8', errors='ignore')})

        return result


class MoozPacketDecoder:
    """Stream decoder that extracts packets and ASCII responses from a byte stream."""
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data: bytes) -> List[Dict[str, Any]]:
        self.buffer.extend(data)
        messages = []

        while len(self.buffer) > 0:
            # Check for binary packet header 0xAA 0xBB
            idx = -1
            for i in range(len(self.buffer) - 1):
                if self.buffer[i] == 0xAA and self.buffer[i + 1] == 0xBB:
                    idx = i
                    break

            if idx > 0:
                # Leading ASCII data before binary packet
                prefix = bytes(self.buffer[:idx])
                ascii_text = prefix.decode('utf-8', errors='ignore').strip()
                if ascii_text:
                    for line in ascii_text.splitlines():
                        line = line.strip()
                        if line:
                            messages.append({'type': 'ascii', 'text': line})
                del self.buffer[:idx]
                idx = 0

            if idx == 0:
                if len(self.buffer) < 17:
                    break  # Wait for full header

                payload_len = struct.unpack_from('<H', self.buffer, 2)[0]
                total_len = 17 + payload_len

                if len(self.buffer) < total_len:
                    break  # Wait for full payload + crc16

                pkt_bytes = bytes(self.buffer[:total_len])
                parsed = MoozProtocol.parse_packet(pkt_bytes)
                if parsed:
                    messages.append(parsed)
                    del self.buffer[:total_len]
                else:
                    # Invalid checksum or header, advance 1 byte
                    del self.buffer[0]
            else:
                # No binary header found, check for newline-delimited ASCII lines
                newline_pos = self.buffer.find(b'\n')
                if newline_pos != -1:
                    line_bytes = bytes(self.buffer[:newline_pos + 1])
                    del self.buffer[:newline_pos + 1]
                    line_str = line_bytes.decode('utf-8', errors='ignore').strip()
                    if line_str:
                        messages.append({'type': 'ascii', 'text': line_str})
                else:
                    # Keep accumulating unless buffer is abnormally large
                    if len(self.buffer) > 4096:
                        del self.buffer[:2048]
                    break

        return messages


# ============================================================================
# 2. LASER G-CODE GENERATOR
# ============================================================================

class LaserGenerator:
    """
    Dobot MOOZ Laser Engraver G-code Generator.
    Supports Grayscale PWM (S0-255), Floyd-Steinberg, Atkinson dithering,
    binary threshold, and bi-directional serpentine scanning.
    """
    def __init__(self, options: Optional[Dict[str, Any]] = None):
        opts = options or {}
        self.engraving_speed = float(opts.get('engravingSpeed', opts.get('engraving_speed', 1500)))
        self.travel_speed = float(opts.get('travelSpeed', opts.get('travel_speed', 3000)))
        self.power_min = float(opts.get('powerMin', opts.get('power_min', 0)))      # % (0-100)
        self.power_max = float(opts.get('powerMax', opts.get('power_max', 100)))    # % (0-100)
        self.mode = opts.get('mode', 'gray')                                      # 'gray', 'binary', 'dither'
        self.dither_type = opts.get('ditherType', opts.get('dither_type', 'floyd'))# 'floyd', 'atkinson'
        self.threshold = int(opts.get('threshold', 128))
        self.invert = bool(opts.get('invert', False))
        self.border = int(opts.get('border', 0))
        self.origin_x = float(opts.get('originX', opts.get('origin_x', 0.0)))
        self.origin_y = float(opts.get('originY', opts.get('origin_y', 0.0)))
        self.target_width = float(opts.get('targetWidth', opts.get('target_width', 50.0)))
        self.target_height = float(opts.get('targetHeight', opts.get('target_height', 50.0)))

    def _load_image(self, image_input: Union[str, bytes, 'Image.Image']) -> Tuple[List[float], int, int]:
        """Loads image and returns (gray_array, width, height)."""
        if not HAS_PIL:
            raise RuntimeError("Pillow (PIL) is required for image processing. Run: pip install pillow")

        img = None
        if isinstance(image_input, Image.Image):
            img = image_input
        elif isinstance(image_input, (bytes, bytearray)):
            img = Image.open(io.BytesIO(image_input))
        elif isinstance(image_input, str):
            if image_input.startswith('data:'):
                b64_str = image_input.split(',', 1)[1]
                raw_bytes = base64.b64decode(b64_str)
                img = Image.open(io.BytesIO(raw_bytes))
            elif os.path.exists(image_input):
                img = Image.open(image_input)
            else:
                raw_bytes = base64.b64decode(image_input)
                img = Image.open(io.BytesIO(raw_bytes))
        else:
            raise ValueError("Unsupported image input type")

        img = img.convert('RGBA')
        width, height = img.size

        # Convert to grayscale array (0-255: 0=black/burn, 255=white/off)
        gray = [0.0] * (width * height)
        pixels = img.load()
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                val = 0.299 * r + 0.587 * g + 0.114 * b
                if a < 128:
                    val = 255.0  # Transparent is unburnt
                if self.invert:
                    val = 255.0 - val
                gray[y * width + x] = float(val)

        return gray, width, height

    def _apply_dithering(self, gray: List[float], width: int, height: int, dither_type: str):
        """Applies Floyd-Steinberg or Atkinson error diffusion dithering."""
        for y in range(height):
            for x in range(width):
                idx = y * width + x
                old_val = gray[idx]
                new_val = 0.0 if old_val < self.threshold else 255.0
                gray[idx] = new_val
                err = old_val - new_val

                if dither_type == 'floyd':
                    # Floyd-Steinberg
                    if x + 1 < width:
                        gray[idx + 1] += err * (7.0 / 16.0)
                    if y + 1 < height:
                        if x - 1 >= 0:
                            gray[idx + width - 1] += err * (3.0 / 16.0)
                        gray[idx + width] += err * (5.0 / 16.0)
                        if x + 1 < width:
                            gray[idx + width + 1] += err * (1.0 / 16.0)
                else:
                    # Atkinson
                    if x + 1 < width:
                        gray[idx + 1] += err * (1.0 / 8.0)
                    if x + 2 < width:
                        gray[idx + 2] += err * (1.0 / 8.0)
                    if y + 1 < height:
                        if x - 1 >= 0:
                            gray[idx + width - 1] += err * (1.0 / 8.0)
                        gray[idx + width] += err * (1.0 / 8.0)
                        if x + 1 < width:
                            gray[idx + width + 1] += err * (1.0 / 8.0)
                    if y + 2 < height:
                        gray[idx + width * 2] += err * (1.0 / 8.0)

    def generate(self, image_input: Union[str, bytes, 'Image.Image']) -> Dict[str, Any]:
        """Generates complete Dobot MOOZ Laser G-code."""
        gray, width, height = self._load_image(image_input)

        if self.mode == 'dither':
            self._apply_dithering(gray, width, height, self.dither_type)

        gcode: List[str] = []
        time_seconds = 0.0

        # Header
        gcode.append('; Dobot MOOZ Laser Engraving G-code')
        gcode.append(f'; Dimensions: {self.target_width:.1f} x {self.target_height:.1f} mm')
        gcode.append(f'; Speed: Cut {self.engraving_speed} mm/min, Travel {self.travel_speed} mm/min')
        gcode.append(f'; Mode: {self.mode}')
        gcode.append('G28 ; Home all axes')
        gcode.append('M106 S0 ; Ensure laser off')
        gcode.append(f'G1 X0 Y0 Z0 F{self.travel_speed}')
        gcode.append(f'G0 S0 F{self.travel_speed}')

        pixel_size_x = self.target_width / width
        pixel_size_y = self.target_height / height

        cur_x = 0.0
        cur_y = 0.0

        # Optional perimeter border
        if self.border > 0:
            border_power = int(round(255 * (self.power_max / 100.0)))
            for _ in range(self.border):
                x0 = f"{self.origin_x:.2f}"
                y0 = f"{self.origin_y:.2f}"
                x1 = f"{(self.origin_x + self.target_width):.2f}"
                y1 = f"{(self.origin_y + self.target_height):.2f}"
                gcode.append(f"G0 X{x0} Y{y0} S0 F{self.travel_speed}")
                gcode.append(f"G1 X{x1} Y{y0} S{border_power} F{self.engraving_speed}")
                gcode.append(f"G1 X{x1} Y{y1} S{border_power} F{self.engraving_speed}")
                gcode.append(f"G1 X{x0} Y{y1} S{border_power} F{self.engraving_speed}")
                gcode.append(f"G1 X{x0} Y{y0} S{border_power} F{self.engraving_speed}")
                time_seconds += (2 * (self.target_width + self.target_height)) / (self.engraving_speed / 60.0)

        laser_state = 0  # 0 = off, >0 = power

        # Bi-directional serpentine raster scan
        for y in range(height):
            is_reverse = (y % 2 == 1)
            row_y = self.origin_y + (height - 1 - y) * pixel_size_y

            start_x = width - 1 if is_reverse else 0
            end_x = -1 if is_reverse else width
            step_x = -1 if is_reverse else 1

            for x in range(start_x, end_x, step_x):
                val = gray[y * width + x]
                pos_x = self.origin_x + x * pixel_size_x

                power = 0
                if self.mode == 'gray':
                    burn_val = 255.0 - val
                    if burn_val > 10:
                        min_p = 255.0 * (self.power_min / 100.0)
                        max_p = 255.0 * (self.power_max / 100.0)
                        power = int(round(min_p + (burn_val / 255.0) * (max_p - min_p)))
                        power = min(255, max(0, power))
                else:
                    if val < self.threshold:
                        power = int(round(255.0 * (self.power_max / 100.0)))
                    else:
                        power = 0

                if power <= 10:
                    if laser_state != 0:
                        gcode.append(f"G0 S0 F{self.travel_speed}")
                        laser_state = 0
                else:
                    if laser_state == 0:
                        gcode.append(f"G0 X{pos_x:.2f} Y{row_y:.2f} S0 F{self.travel_speed}")
                        dist = math.hypot(pos_x - cur_x, row_y - cur_y)
                        time_seconds += dist / (self.travel_speed / 60.0)
                    gcode.append(f"G1 X{pos_x:.2f} Y{row_y:.2f} S{power} F{self.engraving_speed}")
                    dist = math.hypot(pos_x - cur_x, row_y - cur_y)
                    time_seconds += dist / (self.engraving_speed / 60.0)
                    laser_state = power

                cur_x = pos_x
                cur_y = row_y

        # Footer
        gcode.append('M106 S0 ; Laser off')
        gcode.append('G0 S0 F3000')
        gcode.append('G28 ; Home')

        return {
            'gcode': '\n'.join(gcode),
            'estimatedTimeMinutes': round(time_seconds / 60.0, 1),
            'linesCount': len(gcode),
            'width': self.target_width,
            'height': self.target_height
        }


# ============================================================================
# 3. CNC 2.5D RELIEF DEPTH SLICING GENERATOR
# ============================================================================

class CncGenerator:
    """
    Dobot MOOZ CNC Carving & 2.5D Relief G-code Generator.
    Supports multi-pass depth slicing from heightmap images.
    """
    def __init__(self, options: Optional[Dict[str, Any]] = None):
        opts = options or {}
        self.cnc_speed = float(opts.get('cncSpeed', opts.get('cnc_speed', 600)))          # mm/min cutting
        self.plunge_speed = float(opts.get('plungeSpeed', opts.get('plunge_speed', 200))) # mm/min plunge
        self.travel_speed = float(opts.get('travelSpeed', opts.get('travel_speed', 1500)))# mm/min rapid
        self.spindle_speed = int(opts.get('spindleSpeed', opts.get('spindle_speed', 12000))) # Spindle RPM
        self.safe_height = float(opts.get('safeHeight', opts.get('safe_height', 5.0)))    # mm clearance
        self.total_depth = float(opts.get('totalDepth', opts.get('total_depth', 2.0)))    # mm max depth
        self.step_depth = float(opts.get('stepDepth', opts.get('step_depth', 0.5)))       # mm per pass
        self.tool_type = opts.get('toolType', opts.get('tool_type', 'vBit'))
        self.tool_diameter = float(opts.get('toolDiameter', opts.get('tool_diameter', 3.175)))
        self.target_width = float(opts.get('targetWidth', opts.get('target_width', 50.0)))
        self.target_height = float(opts.get('targetHeight', opts.get('target_height', 50.0)))
        self.origin_x = float(opts.get('originX', opts.get('origin_x', 0.0)))
        self.origin_y = float(opts.get('originY', opts.get('origin_y', 0.0)))
        self.invert = bool(opts.get('invert', False))

    def _load_depthmap(self, image_input: Union[str, bytes, 'Image.Image']) -> Tuple[List[float], int, int]:
        """Loads image as depth map (0.0 = stock surface, 1.0 = maximum depth)."""
        if not HAS_PIL:
            raise RuntimeError("Pillow (PIL) is required. Run: pip install pillow")

        img = None
        if isinstance(image_input, Image.Image):
            img = image_input
        elif isinstance(image_input, (bytes, bytearray)):
            img = Image.open(io.BytesIO(image_input))
        elif isinstance(image_input, str):
            if image_input.startswith('data:'):
                b64_str = image_input.split(',', 1)[1]
                raw_bytes = base64.b64decode(b64_str)
                img = Image.open(io.BytesIO(raw_bytes))
            elif os.path.exists(image_input):
                img = Image.open(image_input)
            else:
                raw_bytes = base64.b64decode(image_input)
                img = Image.open(io.BytesIO(raw_bytes))
        else:
            raise ValueError("Unsupported image input type")

        img = img.convert('RGBA')
        width, height = img.size

        depth_map = [0.0] * (width * height)
        pixels = img.load()
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                val = 0.299 * r + 0.587 * g + 0.114 * b
                if a < 128:
                    val = 255.0
                if self.invert:
                    val = 255.0 - val
                # Darker pixels = deeper cut
                depth_map[y * width + x] = (255.0 - val) / 255.0

        return depth_map, width, height

    def generate(self, image_input: Union[str, bytes, 'Image.Image']) -> Dict[str, Any]:
        """Generates 2.5D multi-pass relief carving G-code."""
        depth_map, width, height = self._load_depthmap(image_input)

        gcode: List[str] = []
        time_seconds = 0.0

        num_passes = max(1, math.ceil(self.total_depth / self.step_depth))
        pixel_size_x = self.target_width / width
        pixel_size_y = self.target_height / height

        # Safety & Setup
        gcode.append('; Dobot MOOZ CNC Relief Carving G-code')
        gcode.append(f'; Tool: {self.tool_type} (Dia: {self.tool_diameter}mm)')
        gcode.append(f'; Stock Size: {self.target_width:.1f} x {self.target_height:.1f} mm')
        gcode.append(f'; Max Depth: {self.total_depth:.2f}mm in {num_passes} passes (Step: {self.step_depth:.2f}mm)')
        gcode.append(f'; Speeds: Cut {self.cnc_speed} mm/min, Plunge {self.plunge_speed} mm/min, Travel {self.travel_speed} mm/min')
        gcode.append('G21 ; Metric units')
        gcode.append('G90 ; Absolute coordinates')
        gcode.append('G28 ; Home axes')
        gcode.append(f'G0 Z{self.safe_height:.2f} F{self.travel_speed}')
        gcode.append(f'M3 S{self.spindle_speed} ; Spindle Start')
        gcode.append('G4 P2 ; Dwell 2s for spindle ramp-up')

        cur_x = 0.0
        cur_y = 0.0
        cur_z = self.safe_height

        for p in range(1, num_passes + 1):
            cur_pass_depth = min(self.total_depth, p * self.step_depth)
            gcode.append(f'; --- PASS {p}/{num_passes} (Z down to -{cur_pass_depth:.2f}mm) ---')

            for y in range(height):
                is_reverse = (y % 2 == 1)
                row_y = self.origin_y + (height - 1 - y) * pixel_size_y

                start_x = width - 1 if is_reverse else 0
                end_x = -1 if is_reverse else width
                step_x = -1 if is_reverse else 1

                in_cut = False

                for x in range(start_x, end_x, step_x):
                    ratio = depth_map[y * width + x]
                    target_z = -(ratio * cur_pass_depth)
                    pos_x = self.origin_x + x * pixel_size_x

                    if ratio > 0.05:
                        if not in_cut:
                            # Rapid above stock
                            gcode.append(f"G0 X{pos_x:.2f} Y{row_y:.2f} Z{self.safe_height:.2f} F{self.travel_speed}")
                            # Plunge
                            gcode.append(f"G1 Z{target_z:.3f} F{self.plunge_speed}")
                            time_seconds += (self.safe_height - target_z) / (self.plunge_speed / 60.0)
                            in_cut = True
                        else:
                            # Milling cut
                            gcode.append(f"G1 X{pos_x:.2f} Y{row_y:.2f} Z{target_z:.3f} F{self.cnc_speed}")
                            dist = math.hypot(pos_x - cur_x, row_y - cur_y, target_z - cur_z)
                            time_seconds += dist / (self.cnc_speed / 60.0)
                    else:
                        if in_cut:
                            # Retract
                            gcode.append(f"G0 Z{self.safe_height:.2f} F{self.travel_speed}")
                            time_seconds += (self.safe_height - cur_z) / (self.travel_speed / 60.0)
                            in_cut = False

                    cur_x = pos_x
                    cur_y = row_y
                    cur_z = target_z if in_cut else self.safe_height

                if in_cut:
                    gcode.append(f"G0 Z{self.safe_height:.2f} F{self.travel_speed}")
                    cur_z = self.safe_height

        # Footer
        gcode.append(f"G0 Z{self.safe_height:.2f} F{self.travel_speed}")
        gcode.append("M5 ; Spindle Stop")
        gcode.append("G0 X0 Y0 F3000")
        gcode.append("G28 ; Home")

        return {
            'gcode': '\n'.join(gcode),
            'estimatedTimeMinutes': round(time_seconds / 60.0, 1),
            'linesCount': len(gcode),
            'width': self.target_width,
            'height': self.target_height,
            'passes': num_passes
        }


# ============================================================================
# 4. SERIAL COMMUNICATION CONTROLLER (pyserial)
# ============================================================================

class MoozSerialController:
    """Manages serial connection, CH340 auto-detection, jog, and G-code streaming."""
    def __init__(self):
        self.ser = None
        self.port_name = None
        self.baudrate = 115200
        self.is_connected = False
        self.lock = threading.Lock()

        # Reading & streaming threads
        self.read_thread = None
        self.stream_thread = None
        self.running = False
        self.decoder = MoozPacketDecoder()

        # Streaming state
        self.is_streaming = False
        self.is_paused = False
        self.stream_stop_event = threading.Event()
        self.stream_pause_event = threading.Event()
        self.stream_pause_event.set()  # set = running, clear = paused

        self.stream_progress = {
            'isStreaming': False,
            'isPaused': False,
            'currentLine': 0,
            'totalLines': 0,
            'progressPercent': 0.0,
            'elapsedSeconds': 0.0,
            'remainingSeconds': 0.0,
            'lastCommand': '',
            'error': None
        }

        # Latest machine state
        self.machine_state = {
            'position': {'x': 0.0, 'y': 0.0, 'z': 0.0, 'e': 0.0},
            'temperature': {'nozzle': 0.0, 'bed': 0.0},
            'isRunning': False,
            'lastResponse': ''
        }

    def list_ports(self) -> List[Dict[str, Any]]:
        """List available COM ports and auto-detect CH340 / USB serial controllers."""
        if not HAS_SERIAL:
            return [{'device': 'SIMULATION', 'description': 'Virtual Simulator Port', 'is_ch340': True}]

        ports = []
        for p in serial.tools.list_ports.comports():
            desc = p.description or ''
            hwid = p.hwid or ''
            # Check for CH340: VID 1A86, PID 7523 or 'CH340' in description
            is_ch340 = ('1A86' in hwid.upper()) or ('CH340' in desc.upper()) or ('USB-SERIAL' in desc.upper())
            ports.append({
                'device': p.device,
                'description': desc,
                'hwid': hwid,
                'is_ch340': is_ch340
            })
        return ports

    def connect(self, port: str, baudrate: int = 115200, timeout: float = 1.0) -> bool:
        """Connects to the specified serial port."""
        with self.lock:
            if self.is_connected:
                self._disconnect_internal()

            self.port_name = port
            self.baudrate = baudrate

            if port == 'SIMULATION' or not HAS_SERIAL:
                self.is_connected = True
                self.running = True
                return True

            try:
                self.ser = serial.Serial(port, baudrate=baudrate, timeout=timeout)
                self.is_connected = True
                self.running = True

                self.read_thread = threading.Thread(target=self._reader_loop, daemon=True)
                self.read_thread.start()
                return True
            except Exception as e:
                self.is_connected = False
                self.ser = None
                raise ConnectionError(f"Failed to open port {port}: {e}")

    def disconnect(self):
        """Disconnects serial port safely."""
        with self.lock:
            self._disconnect_internal()

    def _disconnect_internal(self):
        self.stop_stream()
        self.running = False
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None
        self.is_connected = False

    def _reader_loop(self):
        """Background thread reading incoming data from serial."""
        while self.running and self.ser and self.ser.is_open:
            try:
                raw = self.ser.read(64)
                if raw:
                    packets = self.decoder.feed(raw)
                    for pkt in packets:
                        self._handle_incoming_packet(pkt)
                else:
                    time.sleep(0.01)
            except Exception:
                break

    def _handle_incoming_packet(self, pkt: Dict[str, Any]):
        p_type = pkt.get('type')
        if p_type == 'pose':
            self.machine_state['position'] = {
                'x': pkt['x'], 'y': pkt['y'], 'z': pkt['z'], 'e': pkt['e']
            }
        elif p_type == 'temp':
            self.machine_state['temperature'] = {
                'nozzle': pkt['nozzle'], 'bed': pkt['bed']
            }
        elif p_type == 'running':
            self.machine_state['isRunning'] = pkt['isRunning']
        elif p_type == 'ascii':
            self.machine_state['lastResponse'] = pkt.get('text', '')

    def send_raw(self, data: Union[str, bytes]):
        """Sends raw string or binary packet to serial."""
        if not self.is_connected:
            raise ConnectionError("Serial port is not connected")

        if isinstance(data, str):
            if not data.endswith('\n'):
                data += '\n'
            b_data = data.encode('utf-8')
        else:
            b_data = data

        if self.ser and self.ser.is_open:
            with self.lock:
                self.ser.write(b_data)

    def send_gcode_packet(self, line: str):
        """Wraps G-code line in Dobot MOOZ binary packet and sends."""
        packet = MoozProtocol.build_gcode_packet(line)
        self.send_raw(packet)

    def jog(self, axis: str, distance: float, feedrate: float = 1500) -> bool:
        """Jogs axis by distance in relative mode (G91)."""
        axis_upper = axis.upper()
        if axis_upper not in ('X', 'Y', 'Z', 'E'):
            raise ValueError(f"Invalid axis: {axis}")
        gcode = f"G91\nG1 {axis_upper}{distance:.3f} F{feedrate}\nG90\n"
        self.send_raw(gcode)
        return True

    def home(self, axes: str = 'XYZ') -> bool:
        """Homes axes with G28."""
        cmd = f"G28 {axes.upper()}\n"
        self.send_raw(cmd)
        return True

    def emergency_stop(self) -> bool:
        """Sends M112 emergency stop and shuts down laser/spindle."""
        self.stop_stream()
        try:
            self.send_raw("M112\nM106 S0\nM5\n")
        except Exception:
            pass
        return True

    def query_status(self):
        """Sends binary queries for position, temp, running state."""
        if self.is_connected and self.ser and self.ser.is_open:
            try:
                self.send_raw(MoozProtocol.build_packet(None, MoozCmd.CURRENT_POS))
                self.send_raw(MoozProtocol.build_packet(None, MoozCmd.CURRENT_TEMP))
                self.send_raw(MoozProtocol.build_packet(None, MoozCmd.RUNNING))
            except Exception:
                pass

    def start_stream(self, gcode_text: str, binary_mode: bool = False):
        """Starts streaming G-code in background thread."""
        if self.is_streaming:
            raise RuntimeError("Streaming is already in progress")

        lines = [line.strip() for line in gcode_text.splitlines() if line.strip() and not line.strip().startswith(';')]
        if not lines:
            raise ValueError("No executable G-code lines to stream")

        self.stream_stop_event.clear()
        self.stream_pause_event.set()
        self.is_streaming = True
        self.is_paused = False

        self.stream_progress = {
            'isStreaming': True,
            'isPaused': False,
            'currentLine': 0,
            'totalLines': len(lines),
            'progressPercent': 0.0,
            'elapsedSeconds': 0.0,
            'remainingSeconds': 0.0,
            'lastCommand': '',
            'error': None
        }

        self.stream_thread = threading.Thread(target=self._stream_worker, args=(lines, binary_mode), daemon=True)
        self.stream_thread.start()

    def pause_stream(self):
        """Pauses active streaming."""
        if self.is_streaming and not self.is_paused:
            self.is_paused = True
            self.stream_pause_event.clear()
            self.stream_progress['isPaused'] = True

    def resume_stream(self):
        """Resumes paused streaming."""
        if self.is_streaming and self.is_paused:
            self.is_paused = False
            self.stream_pause_event.set()
            self.stream_progress['isPaused'] = False

    def stop_stream(self):
        """Stops active streaming immediately."""
        self.stream_stop_event.set()
        self.stream_pause_event.set()
        self.is_streaming = False
        self.is_paused = False
        self.stream_progress['isStreaming'] = False
        self.stream_progress['isPaused'] = False

    def _stream_worker(self, lines: List[str], binary_mode: bool):
        total = len(lines)
        start_time = time.time()

        for idx, line in enumerate(lines):
            if self.stream_stop_event.is_set():
                break

            # Handle pause
            self.stream_pause_event.wait()
            if self.stream_stop_event.is_set():
                break

            # Send command
            try:
                if binary_mode:
                    self.send_gcode_packet(line)
                else:
                    self.send_raw(line)
            except Exception as e:
                self.stream_progress['error'] = str(e)
                break

            # Update progress
            now = time.time()
            elapsed = now - start_time
            done = idx + 1
            percent = (done / total) * 100.0
            rate = done / max(elapsed, 0.001)
            remaining = (total - done) / rate if rate > 0 else 0.0

            self.stream_progress.update({
                'currentLine': done,
                'totalLines': total,
                'progressPercent': round(percent, 1),
                'elapsedSeconds': round(elapsed, 1),
                'remainingSeconds': round(remaining, 1),
                'lastCommand': line
            })

            # Small delay for pacing (or simulated timing)
            time.sleep(0.005)

        self.is_streaming = False
        self.stream_progress['isStreaming'] = False


# ============================================================================
# 5. LOCAL HTTP REST API & PYWEBVIEW UNIFIED ENGINE
# ============================================================================

class MoozEngine:
    """
    Unified Engine providing methods directly callable by pywebview JS API
    and by the local HTTP REST server.
    """
    def __init__(self):
        self.serial = MoozSerialController()
        self.server: Optional[HTTPServer] = None
        self.server_thread: Optional[threading.Thread] = None

    # --- Hardware & Serial API ---
    def get_ports(self) -> List[Dict[str, Any]]:
        return self.serial.list_ports()

    def connect(self, port: str, baudrate: int = 115200) -> Dict[str, Any]:
        self.serial.connect(port, int(baudrate))
        return {'success': True, 'port': port, 'baudrate': baudrate}

    def disconnect(self) -> Dict[str, Any]:
        self.serial.disconnect()
        return {'success': True}

    def get_status(self) -> Dict[str, Any]:
        self.serial.query_status()
        return {
            'connected': self.serial.is_connected,
            'port': self.serial.port_name,
            'baudrate': self.serial.baudrate,
            'stream': self.serial.stream_progress,
            'machine': self.serial.machine_state
        }

    def jog(self, axis: str, distance: float, feedrate: float = 1500) -> Dict[str, Any]:
        self.serial.jog(axis, float(distance), float(feedrate))
        return {'success': True}

    def home(self, axes: str = 'XYZ') -> Dict[str, Any]:
        self.serial.home(axes)
        return {'success': True}

    def emergency_stop(self) -> Dict[str, Any]:
        self.serial.emergency_stop()
        return {'success': True}

    def send_gcode(self, gcode: str) -> Dict[str, Any]:
        for line in gcode.splitlines():
            line = line.strip()
            if line:
                self.serial.send_raw(line)
        return {'success': True}

    # --- CAM Generation API ---
    def generate_laser(self, image_data: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        gen = LaserGenerator(options)
        return gen.generate(image_data)

    def generate_cnc(self, image_data: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        gen = CncGenerator(options)
        return gen.generate(image_data)

    # --- G-code Streaming API ---
    def start_stream(self, gcode: str, binary_mode: bool = False) -> Dict[str, Any]:
        self.serial.start_stream(gcode, binary_mode=binary_mode)
        return {'success': True}

    def pause_stream(self) -> Dict[str, Any]:
        self.serial.pause_stream()
        return {'success': True}

    def resume_stream(self) -> Dict[str, Any]:
        self.serial.resume_stream()
        return {'success': True}

    def stop_stream(self) -> Dict[str, Any]:
        self.serial.stop_stream()
        return {'success': True}

    # --- HTTP Server Management ---
    def start_server(self, host: str = '127.0.0.1', port: int = 9999):
        """Starts background HTTP REST server with full CORS support."""
        if self.server is not None:
            return

        class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
            daemon_threads = True

        handler = _create_mooz_http_handler(self)
        self.server = ThreadedHTTPServer((host, port), handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        print(f"[MOOZ Engine] HTTP REST server listening at http://{host}:{port}/")

    def stop_server(self):
        """Stops background HTTP REST server."""
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


def _create_mooz_http_handler(engine: MoozEngine):
    class MoozHTTPHandler(BaseHTTPRequestHandler):
        def _send_cors_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
            self.send_header('Access-Control-Max-Age', '86400')

        def _json_response(self, code: int, data: Any):
            body = json.dumps(data).encode('utf-8')
            self.send_response(code)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(200)
            self._send_cors_headers()
            self.end_headers()

        def do_GET(self):
            path = self.path.split('?')[0].rstrip('/')
            try:
                if path in ('/api/health', ''):
                    self._json_response(200, {'status': 'ok', 'service': 'mooz-engine', 'version': '3.0.0'})
                elif path == '/api/ports':
                    self._json_response(200, {'ports': engine.get_ports()})
                elif path == '/api/status':
                    self._json_response(200, engine.get_status())
                else:
                    self._json_response(404, {'error': f'Endpoint {path} not found'})
            except Exception as e:
                self._json_response(500, {'error': str(e)})

        def do_POST(self):
            path = self.path.split('?')[0].rstrip('/')
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'

            try:
                data = json.loads(body) if body.strip() else {}
            except Exception:
                data = {}

            try:
                if path == '/api/connect':
                    port = data.get('port')
                    baud = data.get('baudrate', 115200)
                    res = engine.connect(port, baud)
                    self._json_response(200, res)
                elif path == '/api/disconnect':
                    res = engine.disconnect()
                    self._json_response(200, res)
                elif path == '/api/jog':
                    res = engine.jog(data.get('axis', 'X'), data.get('distance', 10.0), data.get('feedrate', 1500))
                    self._json_response(200, res)
                elif path == '/api/home':
                    res = engine.home(data.get('axes', 'XYZ'))
                    self._json_response(200, res)
                elif path == '/api/emergency_stop':
                    res = engine.emergency_stop()
                    self._json_response(200, res)
                elif path == '/api/send_gcode':
                    res = engine.send_gcode(data.get('gcode', ''))
                    self._json_response(200, res)
                elif path == '/api/generate_laser':
                    img_data = data.get('imageData', data.get('image_data', ''))
                    opts = data.get('options', {})
                    res = engine.generate_laser(img_data, opts)
                    self._json_response(200, res)
                elif path == '/api/generate_cnc':
                    img_data = data.get('imageData', data.get('image_data', ''))
                    opts = data.get('options', {})
                    res = engine.generate_cnc(img_data, opts)
                    self._json_response(200, res)
                elif path == '/api/stream/start':
                    res = engine.start_stream(data.get('gcode', ''), data.get('binaryMode', False))
                    self._json_response(200, res)
                elif path == '/api/stream/pause':
                    res = engine.pause_stream()
                    self._json_response(200, res)
                elif path == '/api/stream/resume':
                    res = engine.resume_stream()
                    self._json_response(200, res)
                elif path == '/api/stream/stop':
                    res = engine.stop_stream()
                    self._json_response(200, res)
                else:
                    self._json_response(404, {'error': f'Endpoint {path} not found'})
            except Exception as e:
                self._json_response(500, {'error': str(e)})

        def log_message(self, format, *args):
            # Suppress default noisy console logs for polling
            pass

    return MoozHTTPHandler


# Standalone runner
if __name__ == '__main__':
    port = 9999
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    engine = MoozEngine()
    engine.start_server(port=port)
    print(f"MOOZ Studio Engine running on http://127.0.0.1:{port}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping MOOZ Engine...")
        engine.stop_server()
