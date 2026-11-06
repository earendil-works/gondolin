export PATH=/usr/sbin:/usr/bin:/sbin:/bin
modprobe virtio_net; modprobe af_packet
ip link set lo up; ip link set eth0 up
udhcpc -i eth0 -q -n -s /usr/share/udhcpc/default.script
[ -n "$GUEST_MTU" ] && ip link set eth0 mtu $GUEST_MTU; cat /sys/class/net/eth0/mtu
ip addr show eth0 | grep inet; ip route; cat /etc/resolv.conf
ping -c 2 -W 2 192.168.127.1
ping -c 1 -W 2 8.8.8.8
nslookup example.com 2>&1 | tail -3
getent hosts localhost.localhost
echo hello-echo | nc -w 2 192.0.2.1 7
echo "--- upload 512MiB"
time sh -c 'dd if=/dev/zero bs=1M count=512 2>/dev/null | nc 192.0.2.1 9000'
echo "--- download 512MiB"
curl -s -o /dev/null -w 'download: %{size_download} bytes %{speed_download} B/s\n' http://192.0.2.1:9001/
echo "--- closed port"
curl -s -m 3 http://192.0.2.1:1234/ ; echo "exit=$?"
echo "--- parallel downloads"
for i in 1 2 3 4; do curl -s -o /dev/null -w "par$i: %{speed_download} B/s\n" http://192.0.2.1:9001/ & done; wait
echo "--- guest tcp counters"
grep '^Tcp:' /proc/net/snmp
