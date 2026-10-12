#!/usr/bin/env python3
"""Deep boot test (runs inside the QEMU test container): log in on the serial console as noc/noc, change the password,
inspect the system, and call the app's admin API with the generated key from outside the VM."""
import pexpect, sys, time, subprocess, json, re
fw = ['-bios', '/usr/share/ovmf/OVMF.fd'] if (len(sys.argv) > 1 and sys.argv[1] == 'uefi') else []
cmd = ['qemu-system-x86_64', '-machine', 'q35', '-cpu', 'max', '-m', '2048', '-smp', '2', *fw, '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
       '-drive', 'file=/work/disk.raw,format=raw,if=none,id=d0,snapshot=on', '-device', 'virtio-scsi-pci', '-device', 'scsi-hd,drive=d0',
       '-netdev', 'user,id=n0,hostfwd=tcp::5080-:80,hostfwd=tcp::5443-:443', '-device', 'e1000,netdev=n0']
c = pexpect.spawn(cmd[0], cmd[1:], encoding='utf-8', timeout=400); c.logfile_read = open('/work/login.log', 'w')
ok = lambda m: print('PASS ' + m); bad = lambda m: print('FAIL ' + m)
c.expect('login: '); time.sleep(70)                      # let first-boot (certificate, banner) finish
c.sendline(''); c.expect('login: ')
print('--- banner shown on the login prompt:'); print(c.before[-700:])
c.sendline('noc'); c.expect('Password: '); c.sendline('noc')
i = c.expect(['Current password:', r'\$ '], timeout=30)
if i == 0:
    ok('first login forces a password change')
    c.sendline('noc'); c.expect('New password:'); c.sendline('Appliance-Test-42'); c.expect('Retype new password:'); c.sendline('Appliance-Test-42'); c.expect(r'\$ ', timeout=30)
else: bad('no forced password change')
def run(cmdline, t=40):
    c.sendline(cmdline + '; echo __DONE__'); c.expect(r'\n__DONE__\r*\n', timeout=t); out = c.before; c.expect(r'\$ ', timeout=10); return re.sub(r'\x1b\[\?2004[hl]', '', out.split('\n', 1)[-1].replace('\r', ''))
c.sendline('stty -echo; export PS1="$ "'); c.expect(r'\$ ')
print('--- services:'); print(run('systemctl is-active r1-noc r1-noc-firstboot systemd-networkd systemd-timesyncd; systemctl is-enabled ssh 2>&1 | head -1'))
print('--- listening:'); print(run("ss -ltn | awk 'NR==1||/:80|:443|:22/'"))
print('--- ip:'); print(run('ip -br a | head -3'))
print('--- data owner / cert files:'); print(run('ls -l /var/lib/r1-noc /var/lib/r1-noc/tls | head -14'))
print('--- tls config:'); print(run('cat /var/lib/r1-noc/tls/config.json'))
env = run('sudo -S true <<< Appliance-Test-42 >/dev/null 2>&1; echo Appliance-Test-42 | sudo -S cat /etc/r1-noc.env 2>/dev/null')
m = re.search(r'NOC_ADMIN_KEY=(\S+)', env); key = m.group(1) if m else ''
ok('admin key generated') if len(key) >= 20 else bad('no admin key: ' + env)
print('--- issue file:'); print(run('cat /etc/issue'))
print('--- disk/mem:'); print(run('df -h / | tail -1; free -m | sed -n 2p; node -v; openssl version | head -1'))
def curl(path):
    return subprocess.run(['curl', '-sk', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', f'https://127.0.0.1:5443{path}'], capture_output=True, text=True).stdout
print('admin API without key (from outside):', curl('/api/settings'), '(expect 403)')
print('admin API with key:', curl(f'/api/settings?key={key}'), '(expect 200)')
print('viewer:', curl('/'), '(expect 200)')
def post(path, body, cookie=''):
    h = ['-H', 'Content-Type: application/json'] + (['-H', 'Cookie: ' + cookie] if cookie else [])
    r = subprocess.run(['curl', '-sk', '-m', '15', '-i', '-X', 'POST', *h, '-d', json.dumps(body), f'https://127.0.0.1:5443{path}'], capture_output=True, text=True).stdout
    return r.split('\r\n', 1)[0], r
ln, _ = post('/api/login', {'user': 'noc', 'password': 'wrong-password'}); print('login with a wrong noc password:', ln, '(expect 401)')
ln, full = post('/api/login', {'user': 'noc', 'password': 'Appliance-Test-42'}); print('login with the real noc password:', ln, '(expect 200)')
m2 = re.search(r'noc_session=([0-9a-f]{64})', full); ck = ('noc_session=' + m2.group(1)) if m2 else ''
print('session cookie issued:', bool(ck), '| Secure flag:', 'Secure' in full)
print('admin API with session:', subprocess.run(['curl', '-sk', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Cookie: ' + ck, 'https://127.0.0.1:5443/api/settings'], capture_output=True, text=True).stdout, '(expect 200)')
print('/admin without session:', subprocess.run(['curl', '-sk', '-m', '10', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', 'https://127.0.0.1:5443/admin'], capture_output=True, text=True).stdout, '(expect 302 to /login)')
ln, _ = post('/api/login', {'user': 'root', 'password': 'whatever'}); print('login as root (not allowed):', ln, '(expect 401)')
print('--- app log tail:'); print(run('journalctl -u r1-noc -n 8 --no-pager | cut -c1-160'))
print('--- shutdown'); c.sendline('echo Appliance-Test-42 | sudo -S poweroff'); c.expect(pexpect.EOF, timeout=120); print('powered off cleanly')
