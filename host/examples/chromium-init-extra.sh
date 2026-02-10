# Create messagebus user (needed by dbus-daemon)
if ! id messagebus > /dev/null 2>&1; then
  addgroup -S messagebus 2>/dev/null || true
  adduser -S -G messagebus -h /dev/null -s /sbin/nologin messagebus 2>/dev/null || true
fi

# Compile GSettings schemas (APK post-install scripts don't run)
if command -v glib-compile-schemas > /dev/null 2>&1; then
  glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
fi

# Start D-Bus system bus (needed by Chromium)
mkdir -p /run/dbus
if command -v dbus-daemon > /dev/null 2>&1; then
  dbus-daemon --system
  log "[init] started dbus"
fi

# Point session bus at system bus (no desktop session in sandbox)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket

# Set default Chromium flags for headless sandbox use.
# Alpine's /usr/bin/chromium wrapper sources /etc/chromium/*.conf in lexical order.
# We use a filename that sorts *after* chromium.conf so we can append to distro defaults.
mkdir -p /etc/chromium
rm -f /etc/chromium/zz-gondolin.conf
cat > /etc/chromium/zz-gondolin.conf <<'EOF'
# Appended to any distro defaults from other .conf files
CHROMIUM_FLAGS="$CHROMIUM_FLAGS --headless --no-sandbox --disable-gpu --ignore-certificate-errors --no-first-run --no-default-browser-check"
EOF
log "[init] configured default chromium flags"
