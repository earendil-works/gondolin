export PATH=/usr/sbin:/usr/bin:/sbin:/bin
modprobe fuse; modprobe virtiofs
mkdir -p /mnt/vfs
mount -t virtiofs gondolin /mnt/vfs || { echo "MOUNT FAILED"; dmesg | tail -20; exit 1; }
grep virtiofs /proc/mounts
echo hello > /mnt/vfs/hello.txt && cat /mnt/vfs/hello.txt
# smoke test of the common operations
python3 - <<'PY'
import os, stat
b = "/mnt/vfs/smoke"
os.makedirs(b + "/a/b", exist_ok=True)
open(b + "/a/f", "w").write("one\n")
with open(b + "/a/f", "a") as f: f.write("two\n")
assert open(b + "/a/f").read() == "one\ntwo\n"
os.rename(b + "/a", b + "/c")
assert open(b + "/c/f").read() == "one\ntwo\n" and os.path.isdir(b + "/c/b")
os.symlink("f", b + "/c/l"); assert os.readlink(b + "/c/l") == "f" and open(b + "/c/l").read().startswith("one")
os.link(b + "/c/f", b + "/c/h"); assert os.stat(b + "/c/h").st_nlink == 2
os.chmod(b + "/c/f", 0o600); assert stat.S_IMODE(os.stat(b + "/c/f").st_mode) == 0o600
os.truncate(b + "/c/f", 2); assert open(b + "/c/f").read() == "on"
os.utime(b + "/c/f", (1000000000, 1000000000)); assert int(os.stat(b + "/c/f").st_mtime) == 1000000000
assert sorted(os.listdir(b + "/c")) == ["b", "f", "h", "l"]
try:
    os.rmdir(b + "/c"); raise SystemExit("rmdir of non-empty dir succeeded")
except OSError as e:
    assert e.errno == 39, e
try:
    open(b + "/missing").read(); raise SystemExit("missing file opened")
except FileNotFoundError:
    pass
fd = os.open(b + "/excl", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644); os.close(fd)
try:
    os.open(b + "/excl", os.O_CREAT | os.O_EXCL | os.O_WRONLY); raise SystemExit("O_EXCL ignored")
except FileExistsError:
    pass
import shutil; shutil.rmtree(b)
assert not os.path.exists(b)
st = os.statvfs("/mnt/vfs"); assert st.f_blocks > 0
print("SMOKE OK")
PY
python3 - <<'PY'
import os
seed = 0x2545f491
def rand():
    global seed
    seed ^= (seed << 13) & 0xffffffff
    seed ^= seed >> 17
    seed ^= (seed << 5) & 0xffffffff
    return seed / 0x100000000
line = "export function handler(request, response) { return request.body; }\n"
for i in range(2000):
    d = f"/tmp/tree/pkg{i % 20}/mod{(i // 20) % 10}/sub{i % 3}"
    os.makedirs(d, exist_ok=True)
    size = 256 + int(rand() * 8192) if rand() < 0.9 else 16384 + int(rand() * 49152)
    open(f"{d}/file{i}.ts", "w").write((line * (size // len(line) + 1))[:size])
PY
tar -cf /tmp/src.tar -C /tmp tree && rm -rf /tmp/tree
ms() { echo $(( $1 / 1000000 )); }
# wall time of a shell command in ms
tm() { python3 -c 'import subprocess,sys,time;t=time.perf_counter_ns();subprocess.run(sys.argv[1],shell=True,check=True);print((time.perf_counter_ns()-t)//1000000)' "$1"; }
mbps() { echo $(( 256 * 1000 / ($1 + 1) )); }
MODE=$(sed -n 's/.*fstest=\([a-z]*\).*/\1/p' /proc/cmdline)
if [ "$MODE" = untar ]; then
  mkdir -p /mnt/vfs/u; echo "untar_ms $(tm "tar -xf /tmp/src.tar -C /mnt/vfs/u")"
  umount /mnt/vfs; exit 0
fi
for base in /tmp/ref /mnt/vfs/bench; do
  mkdir -p $base
  echo "=== $base"
  mkdir -p $base/untar; echo "untar_ms $(tm "tar -xf /tmp/src.tar -C $base/untar")"
  echo "small_create_ms $(ms $(python3 /tmp/fsbench.py create $base/small 1000 4096))"
  echo "small_stat_ms $(ms $(python3 /tmp/fsbench.py stat $base/small 1000))"
  echo "small_read_ms $(ms $(python3 /tmp/fsbench.py read $base/small 1000))"
  python3 /tmp/fsbench.py create $base/bigdir 5000 0 >/dev/null
  echo "readdir_5000_ms $(ms $(python3 /tmp/fsbench.py readdir $base/bigdir 5000))"
  sync; echo 3 > /proc/sys/vm/drop_caches
  echo "tree_find_ms $(tm "find $base/untar > /dev/null")"
  sync; echo 3 > /proc/sys/vm/drop_caches
  echo "tree_ls_lR_ms $(tm "ls -lR $base/untar > /dev/null")"
  d=$(tm "dd if=/dev/zero of=$base/large bs=1M count=256 conv=fsync 2>/dev/null"); echo "large_write_ms $d MiBps $(mbps $d)"
  sync; echo 3 > /proc/sys/vm/drop_caches
  d=$(tm "dd if=$base/large of=/dev/null bs=1M 2>/dev/null"); echo "large_read_ms $d MiBps $(mbps $d)"
  echo "rm_tree_ms $(tm "rm -rf $base/untar")"
done
ls /mnt/vfs/bench | head
umount /mnt/vfs
