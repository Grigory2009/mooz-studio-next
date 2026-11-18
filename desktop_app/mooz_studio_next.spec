# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

block_cipher = None

desktop_app_dir = os.path.abspath(r'C:\Users\Григорий\.gemini\antigravity\scratch\mooz-studio-re\desktop_app')

datas = [
    (os.path.join(desktop_app_dir, 'ui'), 'ui'),
    (os.path.join(desktop_app_dir, 'app.ico'), '.'),
]
datas += collect_data_files('webview')
datas += collect_data_files('clr_loader')

binaries = collect_dynamic_libs('webview')

hiddenimports = [
    'clr',
    'pythonnet',
    'clr_loader',
    'webview',
    'webview.platforms.winforms',
    'webview.platforms.edgechromium',
    'serial',
    'serial.tools.list_ports',
    'PIL',
    'PIL.Image',
    'PIL.ImageOps',
    'PIL.ImageFilter',
    'PIL.ImageDraw',
    'engine',
    'http.server',
    'socketserver',
    'mimetypes',
    'urllib.parse',
]
hiddenimports += collect_submodules('webview')
hiddenimports += collect_submodules('clr_loader')
hiddenimports += collect_submodules('pythonnet')

a = Analysis(
    [os.path.join(desktop_app_dir, 'app.py')],
    pathex=[desktop_app_dir],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'scipy', 'unittest'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='MOOZ Studio Next',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(desktop_app_dir, 'app.ico'),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='MOOZ Studio Next',
)
