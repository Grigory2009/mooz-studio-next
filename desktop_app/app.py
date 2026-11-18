#!/usr/bin/env python3
"""
MOOZ Studio Next — Desktop Application Entry Point
Integrates:
- Backend: Dobot MOOZ binary protocol, CAM generators, and Serial Streaming (engine.py)
- Frontend: 100% Offline Dark-Themed SPA (ui/)
- Native Shell: PyWebView (Edge WebView2) with zero CORS issues
"""

import sys
import os
import socket
import threading
import mimetypes
import argparse
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Force UTF-8 on Windows stdout/stderr
if sys.platform == 'win32':
    try:
        if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Add application directory to sys.path
if getattr(sys, 'frozen', False):
    APP_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    # Attach to parent console if invoked from terminal
    if sys.platform == 'win32':
        try:
            import ctypes
            if ctypes.windll.kernel32.AttachConsole(-1):
                sys.stdout = open('CONOUT$', 'w', encoding='utf-8', errors='replace', buffering=1)
                sys.stderr = open('CONOUT$', 'w', encoding='utf-8', errors='replace', buffering=1)
        except Exception:
            pass
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

# Import backend engine
try:
    from engine import MoozEngine, _create_mooz_http_handler
except ImportError:
    # If run from different CWD
    sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__))))
    from engine import MoozEngine, _create_mooz_http_handler

# Ensure mime types are registered
mimetypes.init()
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('text/html', '.html')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('image/png', '.png')
mimetypes.add_type('image/x-icon', '.ico')


def find_free_port(preferred_port=9999, host='127.0.0.1'):
    """Check if preferred_port is available; if not, find an open port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, preferred_port))
            return preferred_port
        except OSError:
            pass

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


class ThreadedMoozServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def create_unified_request_handler(engine: MoozEngine, ui_dir: str):
    """
    Creates an HTTP request handler that serves both:
    1. /api/... REST endpoints from MoozEngine
    2. Static assets from ui_dir for all other routes
    """
    base_api_handler_cls = _create_mooz_http_handler(engine)

    class UnifiedHandler(base_api_handler_cls):
        def _serve_static_file(self, req_path: str):
            clean_path = req_path.split('?')[0].split('#')[0]
            if clean_path in ('', '/'):
                rel_path = 'index.html'
            else:
                rel_path = clean_path.lstrip('/')

            rel_path = urllib.parse.unquote(rel_path)
            # Prevent directory traversal
            target_path = os.path.normpath(os.path.join(ui_dir, rel_path))
            try:
                common = os.path.commonpath([ui_dir, target_path])
                if common != os.path.normpath(ui_dir):
                    self._json_response(403, {'error': 'Forbidden'})
                    return
            except ValueError:
                self._json_response(403, {'error': 'Forbidden'})
                return

            if os.path.isdir(target_path):
                target_path = os.path.join(target_path, 'index.html')

            if not os.path.exists(target_path) or not os.path.isfile(target_path):
                self._json_response(404, {'error': f'File not found: {rel_path}'})
                return

            # Determine content type
            content_type, _ = mimetypes.guess_type(target_path)
            if not content_type:
                if target_path.endswith('.js') or target_path.endswith('.mjs'):
                    content_type = 'application/javascript; charset=utf-8'
                elif target_path.endswith('.css'):
                    content_type = 'text/css; charset=utf-8'
                elif target_path.endswith('.json'):
                    content_type = 'application/json; charset=utf-8'
                else:
                    content_type = 'application/octet-stream'
            elif content_type.startswith('text/') or content_type == 'application/javascript' or content_type == 'application/json':
                content_type += '; charset=utf-8'

            try:
                with open(target_path, 'rb') as f:
                    content = f.read()

                self.send_response(200)
                self._send_cors_headers()
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(content)))
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                self._json_response(500, {'error': f'Failed reading static file: {str(e)}'})

        def do_GET(self):
            path = self.path.split('?')[0].rstrip('/')
            if path.startswith('/api'):
                # Delegate to base API handler
                super().do_GET()
            else:
                self._serve_static_file(self.path)

        def log_message(self, format, *args):
            # Silence high-frequency polling logs
            pass

    return UnifiedHandler


class MoozDesktopApp:
    def __init__(self, host: str = '127.0.0.1', port: int = 9999):
        self.host = host
        self.port = port
        self.engine = MoozEngine()
        self.server: HTTPServer = None
        self.server_thread: threading.Thread = None
        self.window = None

        # Resolve UI directory
        self.ui_dir = os.path.join(APP_DIR, 'ui')
        if not os.path.isdir(self.ui_dir):
            # Fallback relative to script
            self.ui_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ui')

        # Icon path
        self.icon_path = os.path.join(APP_DIR, 'app.ico')
        if not os.path.exists(self.icon_path):
            self.icon_path = None

    def start_server(self):
        self.port = find_free_port(self.port, self.host)
        handler_cls = create_unified_request_handler(self.engine, self.ui_dir)
        self.server = ThreadedMoozServer((self.host, self.port), handler_cls)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        print(f"[MOOZ Studio Next] Unified Server running at http://{self.host}:{self.port}/")
        print(f"[MOOZ Studio Next] Serving UI from: {self.ui_dir}")

    def stop_server(self):
        if self.engine:
            try:
                self.engine.disconnect()
            except Exception:
                pass
        if self.server:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
            self.server = None
            print("[MOOZ Studio Next] Unified Server stopped cleanly.")

    def run(self, debug: bool = False):
        self.start_server()

        # Import pywebview
        try:
            import webview
        except ImportError:
            print("[Error] pywebview is not installed. Please install it using: pip install pywebview")
            sys.exit(1)

        app_url = f"http://{self.host}:{self.port}/index.html"

        # Create native window with pywebview
        window_kwargs = {
            'title': 'MOOZ Studio Next',
            'url': app_url,
            'js_api': self.engine,
            'width': 1280,
            'height': 840,
            'min_size': (1024, 700),
            'background_color': '#020617',
            'text_select': True
        }

        self.window = webview.create_window(**window_kwargs)

        print("[MOOZ Studio Next] Launching Desktop Window...")
        try:
            webview.start(debug=debug)
        finally:
            self.stop_server()


def run_self_test(host='127.0.0.1', port=9999):
    """Run verification self-test for backend server and UI asset serving."""
    import urllib.request
    import json

    print("--- Running MoozDesktopApp Self-Test ---")
    app = MoozDesktopApp(host=host, port=port)
    app.start_server()
    base_url = f"http://{app.host}:{app.port}"

    try:
        # 1. Test UI index.html
        print(f"1. Fetching {base_url}/index.html...")
        with urllib.request.urlopen(f"{base_url}/index.html", timeout=3) as res:
            assert res.status == 200
            content = res.read().decode('utf-8')
            assert 'MOOZ Studio Next' in content
            content_type = res.headers.get('Content-Type')
            assert 'text/html' in content_type
            print(f"   [PASS] index.html received successfully ({len(content)} bytes)")

        # 2. Test static JS module
        print(f"2. Fetching {base_url}/js/app.js...")
        with urllib.request.urlopen(f"{base_url}/js/app.js", timeout=3) as res:
            assert res.status == 200
            content = res.read().decode('utf-8')
            assert 'MACHINE_BEDS' in content or 'currentTab' in content
            content_type = res.headers.get('Content-Type')
            assert 'javascript' in content_type
            print(f"   [PASS] js/app.js received with correct JS MIME type")

        # 3. Test API Health
        print(f"3. Fetching {base_url}/api/health...")
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=3) as res:
            assert res.status == 200
            data = json.loads(res.read().decode('utf-8'))
            assert data.get('status') == 'ok'
            assert data.get('service') == 'mooz-engine'
            print(f"   [PASS] API Health verified: {data}")

        # 4. Test API Ports
        print(f"4. Fetching {base_url}/api/ports...")
        with urllib.request.urlopen(f"{base_url}/api/ports", timeout=3) as res:
            assert res.status == 200
            data = json.loads(res.read().decode('utf-8'))
            assert 'ports' in data
            print(f"   [PASS] API Ports verified: {data}")

        # 5. Test API Status
        print(f"5. Fetching {base_url}/api/status...")
        with urllib.request.urlopen(f"{base_url}/api/status", timeout=3) as res:
            assert res.status == 200
            data = json.loads(res.read().decode('utf-8'))
            assert 'connected' in data
            print(f"   [PASS] API Status verified: connected={data['connected']}")

        # 6. Test CORS headers
        print(f"6. Verifying CORS headers on API...")
        req = urllib.request.Request(f"{base_url}/api/status", headers={'Origin': 'http://localhost:3000'})
        with urllib.request.urlopen(req, timeout=3) as res:
            cors = res.headers.get('Access-Control-Allow-Origin')
            assert cors == '*'
            print(f"   [PASS] CORS Access-Control-Allow-Origin: {cors}")

        print("\n>>> ALL DESKTOP APP SERVER TESTS PASSED (100%) <<<")
        return True
    finally:
        app.stop_server()


def main():
    parser = argparse.ArgumentParser(description="MOOZ Studio Next — Desktop Application")
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind local server")
    parser.add_argument("--port", type=int, default=9999, help="Port to bind local server (default: 9999)")
    parser.add_argument("--headless", action="store_true", help="Run local server in headless mode (no GUI)")
    parser.add_argument("--debug", action="store_true", help="Enable PyWebView DevTools inspector")
    parser.add_argument("--test", action="store_true", help="Run verification test suite and exit")

    args = parser.parse_args()

    if args.test:
        success = run_self_test(host=args.host, port=args.port)
        os._exit(0 if success else 1)

    app = MoozDesktopApp(host=args.host, port=args.port)

    if args.headless:
        app.start_server()
        print(f"Running in headless mode at http://{app.host}:{app.port}/")
        print("Press Ctrl+C to terminate.")
        try:
            import time
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nShutting down...")
            app.stop_server()
    else:
        app.run(debug=args.debug)


if __name__ == '__main__':
    main()
