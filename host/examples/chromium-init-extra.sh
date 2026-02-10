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
