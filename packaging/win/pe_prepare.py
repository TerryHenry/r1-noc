#!/usr/bin/env python3
"""Strip the Authenticode signature from node.exe (it is invalidated by embedding the app anyway). usage: pe_prepare.py node.exe out.exe"""
import struct, sys
d = bytearray(open(sys.argv[1], 'rb').read())
pe = struct.unpack_from('<I', d, 0x3C)[0]; assert d[pe:pe+4] == b'PE\0\0', 'not a PE file'
opt = pe + 24; magic = struct.unpack_from('<H', d, opt)[0]; assert magic == 0x20B, 'expected PE32+'
dd = opt + 112                       # data directories
sec_off, sec_size = struct.unpack_from('<II', d, dd + 4 * 8)   # index 4 = certificate table (a file offset, not an RVA)
if sec_off and sec_off + sec_size <= len(d):
    struct.pack_into('<II', d, dd + 4 * 8, 0, 0); del d[sec_off:]   # the certificate is appended at the end of the file
    print(f'removed {sec_size} bytes of signature')
struct.pack_into('<I', d, opt + 64, 0)   # CheckSum (0 is accepted for user-mode exes)
open(sys.argv[2], 'wb').write(d)
