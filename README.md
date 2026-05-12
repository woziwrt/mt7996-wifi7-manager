# mt7996-wifi7-manager

A LuCI-based WiFi 7 manager for the **Banana Pi BPI-R4** (MediaTek MT7988A SoC, MT7996 tri-band WiFi 7 chip).

Designed to fully leverage the capabilities of the current Linux kernel 6.12.x, MT7996 firmware, and mt76 driver — including **Multi-Link Operation (MLO)**, per-radio TX power management, and all supported client modes.

> ⚠️ **Requires OpenWrt with MediaTek SDK (MTK SDK)**
> This package is **not compatible with mainline OpenWrt**. Interface naming, MLD configuration, and hostapd parameters differ significantly between MTK SDK builds and standard OpenWrt releases. MTK SDK builds are available via the [bpi-r4-deploy](https://github.com/woziwrt/bpi-r4-deploy) repository.

---

## Hardware

| Component | Details |
|-----------|---------|
| Board | Banana Pi BPI-R4, BPI-R4 PoE |
| SoC | MediaTek MT7988A (Filogic 880) |
| WiFi chip | MT7996 tri-band (2.4 GHz / 5 GHz / 6 GHz) |
| WiFi standard | 802.11be (WiFi 7), MLO |
| RAM variants | 4 GB / 8 GB |

---

## Installation

### Included in firmware (recommended)

`luci-app-wifimgr` is included by default in all BPI-R4 firmware releases built via the [bpi-r4-deploy](https://github.com/woziwrt/bpi-r4-deploy) system — covering all hardware variants (standard, PoE, 4GB, 8GB, BE14000 board).

No additional steps needed after flashing.

### Standalone APK install

Download the latest APK from the [Releases](https://github.com/woziwrt/mt7996-wifi7-manager/releases) page and install:

```sh
# Copy APK to router
scp luci-app-wifimgr-1.1.0-r20260511.apk root@192.168.1.1:/tmp/

# Install (no internet required)
ssh root@192.168.1.1 'apk add --allow-untrusted --no-network /tmp/luci-app-wifimgr-*.apk'
```

Then open LuCI → **Network → WiFi Manager**.

---

## Features

### Wizards — guided network setup

| Wizard | Description |
|--------|-------------|
| **MLO AP** | Creates a Multi-Link Operation AP across 2 or 3 bands. Supports 2G+5G, 2G+6G, 5G+6G, or all three simultaneously. WPA3 enforced. |
| **AP** | Creates a standard single-band AP on any radio. Full control over channel, width, encryption, SSID isolation, hidden SSID, client limits. DFS channels supported with CAC progress indication. |
| **Station** | Connects to an upstream WiFi network on 2.4G or 5G. MLO STA mode supported (multi-band client connecting to an MLO AP). |
| **WDS / Bridge** | Sets up a wireless bridge using 4-address WDS mode or L2 relayd ARP proxy. |
| **Repeater** | Creates an uplink STA connection plus a local AP on a separate radio (L3 NAT). |
| **Country** | Changes regulatory domain. Requires reboot to apply kernel regulatory database. |

### Networks tab

Live list of all configured networks with status indicators, band pills, encryption labels, and client counts. Each row expands to show full configuration. Inline edit and remove with wifi reload.

### Radios tab

Per-radio configuration (channel, bandwidth, country) and TX power management:

| Mode | Description |
|------|-------------|
| **Regulatory** | Country SKU table applied. `sku_idx=0`, no manual txpower override. |
| **eFuse max** | Driver runs at hardware eFuse maximum. Requires reboot. |
| **Manual** | Per-radio dBm cap. `sku_idx=0` + `txpower=N`. |

### Clients tab

Live client list showing signal (color-coded), WiFi generation badge (WiFi 4/5/6/7), bitrate, and per-link data for MLO clients. Disconnect button.

### Diagnostics tab

Firmware version, CPU and WiFi chip temperatures, per-radio channel utilization / noise / TX stats, MLO internals (MLD address, active links, EMLSR/STR status), and log download.

---

## Architecture

Three-layer JavaScript architecture running inside LuCI's rpcd/ubus sandbox:

```
index.js      — UI layer (plain JS, LuCI DOM helpers, no framework)
    │
layer3.js     — Wizard orchestration (high-level flows)
    │
layer2.js     — Structured data model (semantic objects)
    │
layer1.js     — Raw hardware access (UCI, ubus, iw, hostapd_cli, wpa_cli, sysfs)
```

All hardware write operations are serialized through an `hwBusy` mutex in layer1 to prevent concurrent UCI conflicts.

---

## Known limitations

| Limitation | Details |
|------------|---------|
| **6G STA (non-MLO)** | Not supported. MT7996 driver always routes band2 through the MLD code path — standalone 6G STA scan returns no results. 6G is accessible via MLO STA only. |
| **MLO AP + MLO STA simultaneously** | Running both on the same three radios crashes the MT7996 driver. The wizard blocks this combination with an inline error. |
| **Per-link RSSI on secondary MLO links** | MT7996 driver reports signal only for the primary data link. Secondary links show `—`. |
| **6G channel utilization** | Always reported as `n/a` — driver bug (`mbssid=1` causes hostapd to report 126%). Filtered in layer2. |
| **wifi reload with new AP on MLO radio** | Adding a 3rd MBSSID to an MLO radio via `wifi reload` triggers an EDCCA crash. wizardMLO always reboots to work around this. |

---

## Requirements

- OpenWrt with **MediaTek SDK (MTK SDK)** — kernel 6.12.x, MT7996 firmware, mt76 driver
- Board: Banana Pi BPI-R4 or BPI-R4 PoE (MT7988A / MT7996)
- LuCI installed

Not compatible with mainline OpenWrt due to differences in interface naming (`ap-mld-*`), MLD UCI configuration, and hostapd vendor extensions.

---

## License

MIT
