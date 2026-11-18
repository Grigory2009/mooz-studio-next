#!/usr/bin/env python3
"""
Dobot MOOZ Direct Serial & WiFi CLI Bridge
Reverse engineered binary framing protocol with CRC8 and CRC16-IBM
"""

import sys
import time
import struct
import argparse
try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None

CRC8_TABLE = [
    0,7,14,9,28,27,18,21,56,63,54,49,36,35,42,45,112,119,126,121,108,107,98,101,72,79,70,65,84,83,90,93,
    224,231,238,233,252,251,242,245,216,223,214,209,196,195,202,205,144,151,158,153,140,139,130,133,168,175,166,161,180,179,186,189,
    199,192,201,206,219,220,213,210,255,248,241,246,227,228,237,234,183,176,185,190,171,172,165,162,143,136,129,134,147,148,157,154,
    39,32,41,46,59,60,53,50,31,24,17,22,3,4,13,10,87,80,89,94,75,76,69,66,111,104,97,102,115,116,125,122,
    137,142,135,128,149,146,155,156,177,182,191,184,173,170,163,164,249,254,247,240,229,226,235,236,193,198,207,200,221,218,211,212,
    105,110,103,96,117,114,123,124,81,86,95,88,77,74,67,68,25,30,23,16,5,2,11,12,33,38,47,40,61,58,51,52,
    78,73,64,71,82,85,92,91,118,113,120,127,106,109,100,99,62,57,48,55,34,37,44,43,6,1,8,15,26,29,20,19,
    174,169,160,167,178,181,188,187,150,145,152,159,138,141,132,131,222,217,208,215,194,197,204,203,230,225,232,239,250,253,244,243
]

def crc8_atm(data: bytes) -> int:
    crc = 0
    for b in data:
        crc = CRC8_TABLE[(crc ^ b) & 0xFF]
    return crc & 0xFF

def crc16_ibm(data: bytes) -> int:
    crc = 0x0000
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF

class MoozBridge:
    def __init__(self, port: str = None, baud: int = 115200):
        self.port = port
        self.baud = baud
        self.ser = None
        self.seq = 1

    def auto_detect_port(self) -> str:
        if not serial:
            return None
        ports = list(serial.tools.list_ports.comports())
        for p in ports:
            # Check for CH340 / USB serial (VID 1A86 PID 7523)
            if (p.vid == 0x1A86 and p.pid == 0x7523) or 'CH340' in p.description or 'USB-SERIAL' in p.description:
                return p.device
        return ports[0].device if ports else None

    def connect(self):
        if not serial:
            print("Error: pyserial is not installed. Install with: pip install pyserial")
            return False
        if not self.port:
            self.port = self.auto_detect_port()
        if not self.port:
            print("Error: No MOOZ serial port found. Connect USB cable.")
            return False

        print(f"Connecting to MOOZ on {self.port} @ {self.baud} baud...")
        self.ser = serial.Serial(self.port, self.baud, timeout=1.0)
        time.sleep(2.0) # Wait for MCU reset
        print("Connected!")
        return True

    def build_packet(self, payload: bytes, cmd_id: int) -> bytes:
        payload_len = len(payload)
        # Header (14 bytes)
        # 0..1: 0xAA 0xBB
        # 2..3: uint16 LE payload_len
        # 4: 0x10 (version)
        # 5: 0x14 (config)
        # 6..9: uint32 LE seq
        # 10: 0x00 (src PC)
        # 11: 0x10 (dst MOOZ)
        # 12: 0x04 (cmd set)
        # 13: cmd_id
        head = struct.pack('<2sHBBIBBBB', b'\xAA\xBB', payload_len, 0x10, 0x14, self.seq, 0x00, 0x10, 0x04, cmd_id)
        self.seq += 1
        h_crc = struct.pack('B', crc8_atm(head))
        packet_body = head + h_crc + payload
        p_crc = struct.pack('<H', crc16_ibm(packet_body))
        return packet_body + p_crc

    def send_gcode(self, gcode_line: str):
        line = gcode_line.strip() + '\n'
        packet = self.build_packet(line.encode('ascii'), cmd_id=0)
        self.ser.write(packet)

    def query_pose(self):
        packet = self.build_packet(b'', cmd_id=2)
        self.ser.write(packet)

    def stream_file(self, gcode_filepath: str):
        with open(gcode_filepath, 'r') as f:
            lines = [l.strip() for l in f.readlines() if l.strip() and not l.startswith(';')]

        total = len(lines)
        print(f"Streaming {total} lines to MOOZ...")
        for idx, line in enumerate(lines, 1):
            self.send_gcode(line)
            time.sleep(0.015) # Feed pacing
            if idx % 50 == 0 or idx == total:
                percent = (idx / total) * 100
                print(f"\rProgress: [{idx}/{total}] {percent:.1f}%", end='', flush=True)
        print("\nStreaming finished!")

def main():
    parser = argparse.ArgumentParser(description="Dobot MOOZ CLI Bridge & Sender")
    parser.add_argument("--port", help="Serial port (e.g. COM3 or /dev/ttyUSB0)")
    parser.add_argument("--baud", type=int, default=115200, help="Baud rate (default: 115200)")
    parser.add_argument("--send", help="Send single G-code line (e.g. 'G28')")
    parser.add_argument("--file", help="Stream full G-code file")
    parser.add_argument("--interactive", action="store_true", help="Start interactive G-code console")

    args = parser.parse_args()

    bridge = MoozBridge(port=args.port, baud=args.baud)

    if args.send:
        if bridge.connect():
            print(f"Sending: {args.send}")
            bridge.send_gcode(args.send)
            time.sleep(0.5)
    elif args.file:
        if bridge.connect():
            bridge.stream_file(args.file)
    elif args.interactive:
        if bridge.connect():
            print("MOOZ Interactive Terminal. Type G-code (or 'exit' to quit):")
            while True:
                try:
                    cmd = input("MOOZ> ").strip()
                    if cmd.lower() in ['exit', 'quit']:
                        break
                    if cmd:
                        bridge.send_gcode(cmd)
                except KeyboardInterrupt:
                    break
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
