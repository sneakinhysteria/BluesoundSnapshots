# Bluesound Snapshots

Store and recall BluOS speaker setups with one button. BluOS lets a speaker belong to only one fixed group, so switching between, for example, a home cinema (soundbar + surrounds + sub) and a stereo pair (two speakers + sub) normally means rebuilding groups in the BluOS app. This app snapshots each setup once and recreates it on demand.

- **Snapshots**: fixed groups (stereo pairs, home cinema with channel roles and speaker distances), subwoofer pairing, member and sub levels, audio and subwoofer settings (listening mode, tone controls, crossover, phase, …), volume and mute.
- **Recall**: dissolves what differs, rebuilds the setup, restores levels and settings, checks silently that the group actually plays, and verifies the result.
- **AirPlay 2 receiver** per setup for speakers without AirPlay 2 (e.g. 1st-gen Pulse Flex), active only while that setup is in place.
- **Activity log** of volume, input and format changes on all players.
- Local only: uses the BluOS HTTP API (port 11000) on your network, no cloud account.

Setups are built in the BluOS app; this app only stores and recreates them.

## Requirements

- Docker on a host in the same network as the speakers (Linux; host networking is required).
- Free TCP port 8095 (configurable), UDP 11430 (speaker discovery), and for AirPlay TCP 7000+ and UDP 319/320.
- Tested with Pulse Soundbar+, Pulse Sub+ and Pulse Flex (1st gen) on BluOS 4.16.

## Install with Docker Compose

```sh
mkdir bluesound-snapshot && cd bluesound-snapshot
curl -O https://raw.githubusercontent.com/sneakinhysteria/BluesoundSnapshots/main/deploy/docker-compose.yml
docker compose up -d
```

Open `http://<host>:8095`.

## Unraid

**Option A — Docker template (no plugins)**

1. Copy [`unraid/bluesound-snapshot.xml`](unraid/bluesound-snapshot.xml) to `/boot/config/plugins/dockerMan/templates-user/my-bluesound-snapshot.xml` on the flash drive (e.g. via the Unraid terminal: `wget -O /boot/config/plugins/dockerMan/templates-user/my-bluesound-snapshot.xml https://raw.githubusercontent.com/sneakinhysteria/BluesoundSnapshots/main/unraid/bluesound-snapshot.xml`).
2. **Docker** tab → **Add Container** → **Template**: select *bluesound-snapshot* under *User templates*.
3. Check the values (Network Type **Host**, AppData path, port) and click **Apply**.
4. Open the WebUI from the container's icon menu.

**Option B — manual Add Container**

Docker tab → Add Container, then set:

| Field | Value |
|---|---|
| Name | `bluesound-snapshot` |
| Repository | `ghcr.io/sneakinhysteria/bluesound-snapshots:latest` |
| Network Type | `Host` |
| WebUI | `http://[IP]:[PORT:8095]/` |
| Path `/data` | `/mnt/user/appdata/bluesound-snapshot` |
| Variable `PORT` | `8095` |
| Variable `TZ` | your time zone, e.g. `Europe/Berlin` |

**Option C — Compose Manager plugin**: create a stack with [`deploy/docker-compose.yml`](deploy/docker-compose.yml) and change the volume to `/mnt/user/appdata/bluesound-snapshot:/data`.

Tip: give the speakers fixed addresses (DHCP reservations) in your router. The app identifies speakers by MAC address and finds them again anyway, but other integrations (e.g. Home Assistant) may be configured by IP.

## Configuration

All settings are optional; defaults are detected automatically.

| Variable | Default | |
|---|---|---|
| `PORT` | `8095` | Web UI / API port |
| `TZ` | UTC | Time zone for the activity log |
| `BLUOS_SUBNETS` | auto | Comma-separated subnets to scan for players (/22 or smaller), e.g. `192.168.1.0/24` |
| `BLUOS_SCAN` | on | `off` disables the subnet scan (LSDP and known addresses only) |
| `PUBLIC_URL` | auto | Base URL the speakers use to fetch streams from this app, e.g. `http://192.168.1.10:8095` |
| `AVAHI_INTERFACES` | all | Interfaces AirPlay receivers are announced on, e.g. `br0` |
| `DATA_DIR` | `/data` | Database location |

**Discovery**: players are found via LSDP (the Bluesound broadcast protocol, UDP 11430), previously known addresses, group members reported by their leader, and a scan of the host's local subnets. Some devices (1st-gen Pulse Flex, Pulse Sub+) don't announce themselves via LSDP or mDNS and are only found by the scan. Docker, VM and VPN interfaces are ignored.

## Usage

1. Build a setup in the BluOS app (e.g. stereo pair + sub).
2. In the web app, enter a name under *Current setup* and **Save**.
3. Repeat for other setups (e.g. home cinema).
4. **Recall** switches to a stored setup. The active setup is highlighted.
5. **Edit** changes stored values (settings, levels, volume, home cinema distances, AirPlay name). A changed distance rebuilds the group on recall, because distances can only be set when a group is created.

### AirPlay

Enter an *AirPlay name* in a setup's edit form. While that setup is active, an AirPlay 2 receiver with this name is offered (shairport-sync); the audio is streamed to the group as FLAC. Volume from the iPhone/iPad is applied to the BluOS player. Expect ~5–6 s delay (fine for music, not for video). AirPlay itself is limited to CD-quality audio.

## How recall works

1. Read the current setup; groups that already match the snapshot are kept.
2. Dissolve other groups via their leader (members first, then the sub).
3. Wait until the speakers are back on the network (home cinema members live on the soundbar's private subnet while grouped); after leaving a home cinema group wait another 30 s.
4. Rebuild with channel roles, group name and distances, then pair the sub.
5. Play digital silence at volume 0 and check that playback starts. If not, restart the group's speakers once and rebuild.
6. Restore levels, settings (only values that differ) and volume, then read the setup again and report differences.

Command formats for fixed groups and settings are not part of the public BluOS API documentation; they were taken from the BluOS app's network traffic (`docs/capture/`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/current` | Current setup (+ ids of matching snapshots) |
| GET | `/api/snapshots` | List snapshots |
| POST | `/api/snapshots` `{name}` | Save current setup |
| PATCH | `/api/snapshots/:id` `{name}` | Rename |
| PUT | `/api/snapshots/:id/values` `{zones}` | Edit stored values |
| POST | `/api/snapshots/:id/capture` | Replace with current setup |
| DELETE | `/api/snapshots/:id` | Delete |
| POST | `/api/snapshots/:id/recall` | Start recall, returns job |
| GET | `/api/jobs/:id`, `/api/jobs/running` | Recall progress |
| GET | `/api/events?kind=volume` | Activity log |
| GET | `/api/airplay` | AirPlay receivers |

## Development

```sh
npm install
npm run dev        # Node ≥ 22.18, runs TypeScript directly
npm run typecheck
docker build -t bluesound-snapshot .
```
