#!/bin/sh
# Starts the services shairport-sync needs (D-Bus, Avahi, NQPTP), then the app.
set -e
rm -rf /run/dbus/dbus.pid /run/avahi-daemon/pid
dbus-uuidgen --ensure
dbus-daemon --system
if [ -n "$AVAHI_INTERFACES" ]; then
  sed -i "s/^#\?allow-interfaces=.*/allow-interfaces=$AVAHI_INTERFACES/" /etc/avahi/avahi-daemon.conf
fi
avahi-daemon --daemonize --no-chroot
(/usr/local/bin/nqptp > /dev/null 2>&1) &
exec node --disable-warning=ExperimentalWarning /app/src/server.ts
