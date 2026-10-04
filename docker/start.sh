#!/bin/sh
# Starts the services shairport-sync needs (D-Bus, Avahi, NQPTP), then the app.
set -e
rm -rf /run/dbus/dbus.pid /run/avahi-daemon/pid
dbus-uuidgen --ensure
dbus-daemon --system
# With host networking the host may run its own mDNS responder under the same host name; a clash
# leaves Avahi stuck in "registering" and the AirPlay receivers unannounced. Use a name of our own.
sed -i "s/^#\?host-name=.*/host-name=${AVAHI_HOSTNAME:-bluesound-snapshots}/" /etc/avahi/avahi-daemon.conf
grep -q '^host-name=' /etc/avahi/avahi-daemon.conf || sed -i "s/^\[server\]/[server]\nhost-name=${AVAHI_HOSTNAME:-bluesound-snapshots}/" /etc/avahi/avahi-daemon.conf
if [ -n "$AVAHI_INTERFACES" ]; then
  sed -i "s/^#\?allow-interfaces=.*/allow-interfaces=$AVAHI_INTERFACES/" /etc/avahi/avahi-daemon.conf
fi
avahi-daemon --daemonize --no-chroot
(/usr/local/bin/nqptp > /dev/null 2>&1) &
exec node --disable-warning=ExperimentalWarning /app/src/server.ts
