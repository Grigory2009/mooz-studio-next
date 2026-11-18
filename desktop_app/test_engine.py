"""
Unit and Integration Tests for Dobot MOOZ Engine Core (engine.py)
Tests:
  1. Dobot MOOZ binary serial protocol (CRC8-ATM, CRC16-IBM, framing, parser)
  2. Laser G-code generator (grayscale PWM, Floyd-Steinberg, Atkinson, threshold, serpentine)
  3. CNC 2.5D relief generator (multi-pass depth slicing, speeds, spindle)
  4. Serial controller (port listing, jog, streaming, pause/resume)
  5. HTTP REST JSON API & CORS preflight
"""

import sys
import os
import time
import json
import base64
import io
import urllib.request
import urllib.parse
from PIL import Image, ImageDraw

# Add current dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine import (
    MoozProtocol,
    MoozPacketDecoder,
    MoozCmd,
    crc8_atm,
    crc16_ibm,
    LaserGenerator,
    CncGenerator,
    MoozSerialController,
    MoozEngine
)

def create_test_image(width=32, height=32) -> str:
    """Creates a synthetic gradient test image and returns data URI."""
    img = Image.new('RGB', (width, height), color='white')
    draw = ImageDraw.Draw(img)
    # Draw a black rectangle and gray circle
    draw.rectangle([4, 4, 16, 16], fill='black')
    draw.ellipse([16, 16, 28, 28], fill=(128, 128, 128))
    
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f"data:image/png;base64,{b64}"


def test_mooz_protocol():
    print("\n--- [1] Testing Dobot MOOZ Binary Protocol ---")
    
    # 1. CRC calculations
    crc8_res = crc8_atm(b"G28\n")
    assert crc8_res == 0xA9, f"CRC8 expected 0xA9, got {hex(crc8_res)}"
    
    crc16_res = crc16_ibm(b"G28\n")
    assert crc16_res == 0xBC26, f"CRC16 expected 0xBC26, got {hex(crc16_res)}"
    print("✓ CRC8-ATM & CRC16-IBM calculations validated.")

    # 2. Build G-code packet
    pkt = MoozProtocol.build_packet(b"G28\n", MoozCmd.GCODE, seq=1)
    expected_hex = "aabb040010140100000000100400c84732380aaaf9"
    assert pkt.hex() == expected_hex, f"Packet hex mismatch: {pkt.hex()} != {expected_hex}"
    print(f"✓ Binary packet framing verified: {pkt.hex()}")

    # 3. Parse packet
    parsed = MoozProtocol.parse_packet(pkt)
    assert parsed is not None, "Failed to parse valid packet"
    assert parsed['seq'] == 1
    assert parsed['cmdId'] == MoozCmd.GCODE
    assert parsed['type'] == 'gcode_ack'
    print("✓ Packet parsing verified.")

    # 4. Stream decoder
    decoder = MoozPacketDecoder()
    # Feed with split chunks and leading ASCII noise
    noise = b"echo:busy\nok\n"
    res1 = decoder.feed(noise)
    assert any(m.get('type') == 'ascii' and m.get('text') == 'ok' for m in res1)

    half1 = pkt[:10]
    half2 = pkt[10:]
    res2 = decoder.feed(half1)
    assert len(res2) == 0, "Should wait for complete packet"
    res3 = decoder.feed(half2)
    assert len(res3) == 1 and res3[0]['seq'] == 1, "Should successfully yield decoded packet"
    print("✓ Stream decoder handled chunked binary frames & ASCII lines seamlessly.")


def test_laser_generator():
    print("\n--- [2] Testing Laser G-code Generator ---")
    img_data = create_test_image(20, 20)

    # Test Grayscale PWM mode
    gen_gray = LaserGenerator({
        'mode': 'gray',
        'engravingSpeed': 1200,
        'travelSpeed': 2500,
        'powerMin': 5,
        'powerMax': 90,
        'targetWidth': 20,
        'targetHeight': 20
    })
    res_gray = gen_gray.generate(img_data)
    assert 'G28' in res_gray['gcode']
    assert 'M106 S0' in res_gray['gcode']
    assert 'G1 X' in res_gray['gcode']
    assert res_gray['linesCount'] > 20
    print(f"✓ Grayscale PWM generated: {res_gray['linesCount']} lines, est. {res_gray['estimatedTimeMinutes']} min.")

    # Test Floyd-Steinberg dithering
    gen_floyd = LaserGenerator({
        'mode': 'dither',
        'ditherType': 'floyd',
        'threshold': 128,
        'border': 1
    })
    res_floyd = gen_floyd.generate(img_data)
    assert res_floyd['linesCount'] > 20
    print(f"✓ Floyd-Steinberg dithering & border generated: {res_floyd['linesCount']} lines.")

    # Test Atkinson dithering
    gen_atkinson = LaserGenerator({
        'mode': 'dither',
        'ditherType': 'atkinson',
        'threshold': 128
    })
    res_atkinson = gen_atkinson.generate(img_data)
    assert res_atkinson['linesCount'] > 20
    print(f"✓ Atkinson dithering generated: {res_atkinson['linesCount']} lines.")

    # Test Binary Threshold
    gen_binary = LaserGenerator({
        'mode': 'binary',
        'threshold': 100
    })
    res_binary = gen_binary.generate(img_data)
    assert res_binary['linesCount'] > 20
    print(f"✓ Binary threshold generated: {res_binary['linesCount']} lines.")


def test_cnc_generator():
    print("\n--- [3] Testing CNC 2.5D Relief Depth Slicing Generator ---")
    img_data = create_test_image(20, 20)

    gen_cnc = CncGenerator({
        'cncSpeed': 800,
        'plungeSpeed': 250,
        'spindleSpeed': 10000,
        'safeHeight': 4.0,
        'totalDepth': 1.5,
        'stepDepth': 0.5,
        'targetWidth': 30,
        'targetHeight': 30
    })
    res_cnc = gen_cnc.generate(img_data)
    gcode = res_cnc['gcode']
    
    assert 'M3 S10000' in gcode, "Spindle start missing"
    assert 'M5' in gcode, "Spindle stop missing"
    assert '; --- PASS 1/3' in gcode, "Pass 1 missing"
    assert '; --- PASS 2/3' in gcode, "Pass 2 missing"
    assert '; --- PASS 3/3' in gcode, "Pass 3 missing"
    assert res_cnc['passes'] == 3
    print(f"✓ CNC 2.5D relief generated: 3 slicing passes, {res_cnc['linesCount']} lines, est. {res_cnc['estimatedTimeMinutes']} min.")


def test_serial_controller():
    print("\n--- [4] Testing Serial Controller & G-code Streaming ---")
    controller = MoozSerialController()
    
    ports = controller.list_ports()
    print(f"✓ Scanned ports: {len(ports)} found (e.g. {[p['device'] for p in ports]})")

    # Connect to virtual simulation port
    connected = controller.connect('SIMULATION')
    assert connected and controller.is_connected
    print("✓ Connected to simulator mode.")

    # Jog and home
    controller.jog('X', 10.0)
    controller.home('XYZ')
    controller.emergency_stop()
    print("✓ Jog, Home, Emergency Stop dispatched without error.")

    # Test streaming with enough lines to test pause/resume
    long_gcode = "\n".join([f"G1 X{i} Y{i} F1500" for i in range(100)])
    controller.start_stream(long_gcode)
    time.sleep(0.05)
    prog = controller.stream_progress
    assert prog['totalLines'] == 100
    assert prog['isStreaming']
    print(f"✓ Streaming progress: {prog['currentLine']}/{prog['totalLines']} ({prog['progressPercent']}%)")

    # Pause & resume
    controller.pause_stream()
    assert controller.is_paused
    print("✓ Stream paused.")
    controller.resume_stream()
    assert not controller.is_paused
    print("✓ Stream resumed.")

    # Stop stream
    controller.stop_stream()
    assert not controller.is_streaming
    controller.disconnect()
    print("✓ Serial streaming, flow control, pause/resume and disconnect verified.")


def test_http_api():
    print("\n--- [5] Testing HTTP REST API & CORS Preflight ---")
    engine = MoozEngine()
    test_port = 9998
    engine.start_server(host='127.0.0.1', port=test_port)
    time.sleep(0.2)
    base_url = f"http://127.0.0.1:{test_port}"

    try:
        # 1. OPTIONS CORS Preflight
        req = urllib.request.Request(f"{base_url}/api/ports", method='OPTIONS')
        with urllib.request.urlopen(req) as resp:
            assert resp.status == 200
            cors_header = resp.headers.get('Access-Control-Allow-Origin')
            assert cors_header == '*', f"CORS header missing: {cors_header}"
            print("✓ CORS preflight OPTIONS returns status 200 with Access-Control-Allow-Origin: *")

        # 2. GET /api/health
        req = urllib.request.Request(f"{base_url}/api/health")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data.get('status') == 'ok'
            print(f"✓ GET /api/health: {data}")

        # 3. GET /api/ports
        req = urllib.request.Request(f"{base_url}/api/ports")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert 'ports' in data
            print(f"✓ GET /api/ports: {len(data['ports'])} ports listed.")

        # 4. POST /api/connect
        req = urllib.request.Request(
            f"{base_url}/api/connect",
            data=json.dumps({'port': 'SIMULATION'}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data.get('success') is True
            print("✓ POST /api/connect: connected successfully.")

        # 5. POST /api/jog
        req = urllib.request.Request(
            f"{base_url}/api/jog",
            data=json.dumps({'axis': 'X', 'distance': 5.0, 'feedrate': 1200}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data.get('success') is True
            print("✓ POST /api/jog: jog executed.")

        # 6. POST /api/generate_laser
        img_data = create_test_image(16, 16)
        req = urllib.request.Request(
            f"{base_url}/api/generate_laser",
            data=json.dumps({'imageData': img_data, 'options': {'mode': 'gray', 'targetWidth': 25}}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert 'gcode' in data and data['linesCount'] > 0
            print(f"✓ POST /api/generate_laser: generated {data['linesCount']} lines of G-code.")

        # 7. POST /api/generate_cnc
        req = urllib.request.Request(
            f"{base_url}/api/generate_cnc",
            data=json.dumps({'imageData': img_data, 'options': {'totalDepth': 1.0, 'stepDepth': 0.5}}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert 'gcode' in data and data['passes'] == 2
            print(f"✓ POST /api/generate_cnc: generated {data['passes']} passes CNC G-code.")

        # 8. POST /api/stream/start and GET /api/status
        req = urllib.request.Request(
            f"{base_url}/api/stream/start",
            data=json.dumps({'gcode': 'G28\nG1 X10\nG1 X0\n'}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert data.get('success') is True

        req = urllib.request.Request(f"{base_url}/api/status")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            assert 'stream' in data and 'machine' in data
            print(f"✓ GET /api/status: stream={data['stream']['progressPercent']}%, machine={data['machine']}")

    finally:
        engine.stop_server()
        print("✓ HTTP REST Server stopped cleanly.")


def run_all_tests():
    print("=================================================================")
    print("DOBOT MOOZ ENGINE CORE TEST SUITE")
    print("=================================================================")
    test_mooz_protocol()
    test_laser_generator()
    test_cnc_generator()
    test_serial_controller()
    test_http_api()
    print("\n=================================================================")
    print("ALL TESTS PASSED SUCCESSFULLY! (100% PASS)")
    print("=================================================================\n")

if __name__ == '__main__':
    run_all_tests()
