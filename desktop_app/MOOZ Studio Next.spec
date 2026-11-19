# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('ui', 'ui'), ('app.ico', '.')],
    hiddenimports=['serial', 'serial.tools.list_ports', 'PIL', 'PIL.Image', 'PIL.ImageOps', 'PIL.ImageFilter', 'PIL.ImageDraw', 'webview', 'webview.platforms.winforms', 'webview.platforms.edgechromium', 'clr', 'pythonnet', 'clr_loader', 'engine'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MOOZ Studio Next',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
