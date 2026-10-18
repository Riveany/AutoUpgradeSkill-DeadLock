"""Build the Build Auto-Level addon VPK without the Source 2 workshop tools.

The compiled script (.vjs_c) stores the JavaScript uncompressed in its DATA
block, so the new source is spliced into the original compiled file and the
block size and file size are patched. The two layouts are reused unchanged:
they only include panorama/scripts/build_autolevel.js.

Usage: python -I tools/build.py [output.vpk]
"""
import hashlib
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE = os.path.join(ROOT, 'base')
SRC = os.path.join(ROOT, 'src', 'panorama', 'scripts', 'build_autolevel.js')


def compile_vjs(template_path, js_bytes):
    data = bytearray(open(template_path, 'rb').read())
    file_size, header_version, version, block_offset, block_count = struct.unpack_from('<IHHII', data, 0)
    table = 8 + block_offset
    for i in range(block_count):
        pos = table + i * 12
        kind, rel, size = struct.unpack_from('<4sII', data, pos)
        start = pos + 4 + rel
        if kind == b'DATA':
            if start + size != len(data):
                raise SystemExit('DATA is not the last block; template layout changed')
            out = data[:start] + js_bytes
            struct.pack_into('<I', out, pos + 8, len(js_bytes))
            struct.pack_into('<I', out, 0, len(out))
            return bytes(out)
    raise SystemExit('no DATA block in template')


def pack_vpk(files):
    """files: list of (path inside vpk, bytes). Single-file VPK v2, data embedded."""
    by_ext = {}
    for path, blob in files:
        directory, name = os.path.split(path)
        stem, ext = name.rsplit('.', 1)
        by_ext.setdefault(ext, {}).setdefault(directory or ' ', []).append((stem, blob))

    tree = bytearray()
    payload = bytearray()
    for ext in sorted(by_ext):
        tree += ext.encode() + b'\0'
        for directory in sorted(by_ext[ext]):
            tree += directory.encode() + b'\0'
            for stem, blob in sorted(by_ext[ext][directory]):
                tree += stem.encode() + b'\0'
                tree += struct.pack('<IHHIIH', zlib.crc32(blob) & 0xffffffff, 0, 0x7fff,
                                    len(payload), len(blob), 0xffff)
                payload += blob
            tree += b'\0'
        tree += b'\0'
    tree += b'\0'

    header = struct.pack('<IIIIIII', 0x55aa1234, 2, len(tree), len(payload), 0, 48, 0)
    tree_md5 = hashlib.md5(bytes(tree)).digest()
    archive_md5 = hashlib.md5(b'').digest()
    body = header + bytes(tree) + bytes(payload) + tree_md5 + archive_md5
    return body + hashlib.md5(body).digest()


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'pak21_dir.vpk')
    js = open(SRC, 'rb').read()
    if js.startswith(b'\xef\xbb\xbf'):
        js = js[3:]
    vjs = compile_vjs(os.path.join(BASE, 'build_autolevel.vjs_c'), js)
    files = [
        ('panorama/layout/base_hud.vxml_c', open(os.path.join(BASE, 'base_hud.vxml_c'), 'rb').read()),
        ('panorama/layout/hud_data_feed.vxml_c', open(os.path.join(BASE, 'hud_data_feed.vxml_c'), 'rb').read()),
        ('panorama/scripts/build_autolevel.vjs_c', vjs),
    ]
    blob = pack_vpk(files)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, 'wb').write(blob)
    print('wrote %s (%d bytes, script %d bytes)' % (out_path, len(blob), len(js)))


if __name__ == '__main__':
    main()
