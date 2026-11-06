# Runs a shell command and prints its elapsed wall time in nanoseconds
# (busybox `date` has no %N). usage: timeit.py '<shell command>'
import subprocess
import sys
import time

t0 = time.perf_counter_ns()
rc = subprocess.run(["/bin/sh", "-c", sys.argv[1]]).returncode
dt = time.perf_counter_ns() - t0
if rc != 0:
    raise SystemExit(f"command failed with exit code {rc}")
print(dt)
