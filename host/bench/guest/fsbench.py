# Guest-side filesystem microbenchmarks; prints elapsed nanoseconds.
# usage: fsbench.py <op> <dir> <count> [size]
import os
import sys
import time


def drop_caches():
    os.sync()
    with open("/proc/sys/vm/drop_caches", "w") as f:
        f.write("3\n")


def name(d, i):
    return f"{d}/f{i:05d}"


def main():
    op, d, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
    size = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    if op != "create":
        drop_caches()
    t0 = time.perf_counter_ns()
    if op == "create":
        os.makedirs(d, exist_ok=True)
        data = b"x" * size
        for i in range(count):
            with open(name(d, i), "wb") as f:
                if size:
                    f.write(data)
    elif op == "stat":
        for i in range(count):
            os.stat(name(d, i))
    elif op == "read":
        for i in range(count):
            with open(name(d, i), "rb") as f:
                f.read()
    elif op == "readdir":
        seen = sum(1 for _ in os.scandir(d))
        if seen != count:
            raise SystemExit(f"readdir saw {seen} entries, expected {count}")
    else:
        raise SystemExit(f"unknown op {op}")
    print(time.perf_counter_ns() - t0)


main()
