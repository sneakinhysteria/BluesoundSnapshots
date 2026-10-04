#!/bin/sh
# Called by shairport-sync session hooks: airplay-hook.sh <bridge-id> <start|stop|volume> [volume]
wget -q -O /dev/null "http://127.0.0.1:${PORT:-8095}/internal/airplay/$1/$2${3:+?v=$3}" >/dev/null 2>&1 &
