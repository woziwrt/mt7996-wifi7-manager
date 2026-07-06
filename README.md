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
scp luci-app-wifimgr-2.0.0-r20260517.apk root@192.168.1.1:/tmp/

# Install (no internet required)
ssh root@192.168.1.1 'apk add --allow-untrusted --no-network /tmp/luci-app-wifimgr-*.apk'
```

Then open LuCI → **Network → WiFi Manager**.

---

## Before upgrading — back up your WiFi config

Before any sysupgrade or APK reinstall, export your wireless configuration from the **Diagnostics** tab:

**Network → WiFi Manager → Diagnostics → Wireless Backup / Restore → Download backup**

This saves your current `/etc/config/wireless` as a file. After upgrading, use the same tab to restore it — networks come back exactly as configured, without manual reconfiguration.

> UCI config normally survives an APK reinstall (`apk del` + `apk add`) without a backup. For sysupgrade, the backup is essential — the wireless config is wiped along with the rest of the overlay filesystem.

---

## Screenshots

| Networks | Radios |
|----------|--------|
| ![Networks tab](screenshots/networks-tab.png) | ![Radios tab](screenshots/radios-tab.png) |

| Clients | Diagnostics |
|---------|-------------|
| ![Clients tab](screenshots/clients-tab.png) | ![Diagnostics tab](screenshots/diagnostics-tab.png) |

| Station Wizard | MLO Wizard blocked | AP Wizard blocked |
|----------------|-------------------|-------------------|
| ![wizardStation](screenshots/wizard-station.png) | ![wizardMLO blocked](screenshots/wizard-mlo-blocked.png) | ![wizardAP blocked](screenshots/wizard-ap-blocked.png) |

| WDS / Bridge blocked | Repeater blocked |
|----------------------|-----------------|
| ![wizardWDS blocked](screenshots/wizard-wds-blocked.png) | ![wizardRepeater blocked](screenshots/wizard-repeater-blocked.png) |

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

**Channel advisor** — "Scan channels" button per radio. Scans nearby APs and survey noise, scores interference, recommends top 3 channels as color-coded buttons. Click to apply.

**Preamble puncturing** — per-radio subchannel exclusion (EHT). Visual 20 MHz bitmap — click to puncture/restore individual subchannels for DFS coexistence.

### Clients tab

Live client list showing signal (color-coded), WiFi generation badge (WiFi 4/5/6/7), bitrate, and per-link data for MLO clients. Disconnect button.

### Diagnostics tab

Firmware version, CPU and WiFi chip temperatures, per-radio channel utilization / noise / TX stats, MLO internals (MLD address, active links, EMLSR/STR status), and log download.

**Wireless backup / restore** — download current `/etc/config/wireless` as a backup file. Upload to restore after sysupgrade.

---

### Link Policy tab (MLO AP only)

Available only when an MLO AP is configured. Provides live visibility into the MLO link steering daemon (`mlo-steerd`) and full manual override.

**Daemon control** — start / stop the daemon. Status dot shows running state and PID.

**Steering override** — three-button selector:

| Mode | Behavior |
|------|----------|
| **Auto** | Weighted algorithm runs continuously (default) |
| **All links ON** | Forces all three bands active, disables steering |
| **5G only** | Forces 5G, disables 2.4G and 6G via A-TTLM |

The override is written to UCI (`mlo-steerd.global.mode`) and picked up by the daemon on the next poll cycle — no restart needed.

**Link status** — noise floor per band (dBm), read live from `iw survey`.

**MLO clients table** — live list of connected MLO clients:

- **EMLSR** (e.g. iPhone) — single-radio, switches between links. `max_simul_links = 1`.
- **MLMR** (e.g. router in MLO STA mode) — simultaneous multi-link. `max_simul_links > 1`.

Per-link signal shown for each client. For MLMR clients, the active **Neg-TTLM** mapping is displayed (per AC: BK / BE / VI / VO → active links).

**Daemon log** — last 25 lines of `/tmp/steerd.log`, auto-scrolled to bottom.

---

### How MLO steering works

`mlo-steerd` is a shell daemon running on the AP router, polling every 10 seconds and making two types of decisions:

#### 1. Band steering — which links to activate (SET_ATTLM)

The AP can temporarily disable one or more links for all clients using the `SET_ATTLM` hostapd command. The daemon uses a **weighted score** to decide whether to disable or re-enable each link:

```
score = SNR_normalized × 60%  +  (100 − tx_retries%) × 30%  +  (100 − channel_busy%) × 10%
```

SNR is normalized over the link's soft zone (`[SNR_HARD_LOW .. SNR_HARD_HIGH]`), so a score of 10000 means perfect conditions and 0 means unusable.

**Decision logic per link:**

| Condition | Action |
|-----------|--------|
| SNR < hard_low (2 dB for 6G, 0 dB for 5G) | Immediate disable |
| SNR > hard_high AND retries < 15% | Immediate enable |
| score < 4000 | Disable |
| score > 6000 | Enable |
| 4000 ≤ score ≤ 6000 | No change (hysteresis band) |

Links are evaluated in priority order: 6G first, then 5G only if 6G is already disabled — the client is never left with no link. A 30-second cooldown prevents rapid toggling.

#### 2. Traffic steering — which traffic goes on which link (Neg-TTLM)

When all links are up and an MLMR client is connected, the daemon sends a **Negotiated TID-to-Link Mapping** request, directing different traffic classes to the most appropriate bands:

| Access Category | TIDs | Links | Rationale |
|----------------|------|-------|-----------|
| Background (BK) | 1, 2 | 2.4G + 5G | Bulk traffic — spare 6G capacity for latency-sensitive flows |
| Best Effort (BE) | 0, 3 | All links | General traffic — use full available capacity |
| Video (VI) | 4, 5 | 5G + 6G | High throughput, low latency — skip congested 2.4G |
| Voice (VO) | 6, 7 | 5G only | Minimum latency — stable mid-band, no 6G range risk |

This mapping is hardware-verified on BPI-R4 / MT7996 (2026-05-27). EMLSR clients (e.g. iPhone) do not support Neg-TTLM — band steering only.

The two mechanisms work together: SET_ATTLM shifts clients between bands; Neg-TTLM optimizes traffic distribution when multiple bands are available simultaneously. The daemon is open-source, ships with the package, and autostarted via procd with respawn.

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

## Network reference

### Per-radio capabilities

| Capability | 2.4 GHz (radio0) | 5 GHz (radio1) | 6 GHz (radio2) |
|-----------|:----------------:|:--------------:|:--------------:|
| Access Point (AP) | ✅ | ✅ | ✅ |
| STA / WDS / Relayd uplink | ✅ | ✅ | ❌ ¹ |
| AP + uplink on the same radio | ✅ | ✅ | ❌ |
| Part of MLO AP group | ✅ | ✅ | ✅ |
| Part of MLO STA | ✅ | ✅ | ✅ |
| Max simultaneous APs — no MLO AP active | ~4 via `wifi reload` | ~4 via `wifi reload` | ~4 via `wifi reload` |
| Max simultaneous APs — radio is in MLO AP group | **1 extra** ² | **1 extra** ² | **1 extra** ² |

> ¹ 6 GHz STA (non-MLO) is not supported. The MT7996 driver always routes band2 through the MLD code path — a standalone 6 GHz scan returns no results. 6 GHz uplink is only possible via MLO STA.  
> ² Adding a second extra AP to an MLO radio via `wifi reload` triggers an EDCCA crash in the MT7996 driver. The wizard enforces this limit and always reboots (never reloads) when adding an AP to an MLO radio.

---

### Network combinations — what works and what doesn't

| Combination | Max per router | Notes |
|-------------|:--------------:|-------|
| **MLO AP** (WiFi 7, 2 or 3 bands) | 1 | Requires reboot. Default setup. |
| MLO AP + legacy AP on each MLO radio | 1 per MLO radio | Each slot requires reboot. Wizard enforces the limit. |
| MLO AP + STA uplink | 1 STA | radio0 or radio1. `wifi reload` OK — STA doesn't count toward AP limit. |
| MLO AP + WDS bridge | 1 WDS | radio0 or radio1. 4-address STA mode — does not trigger EDCCA. |
| MLO AP + L2 relayd | 1 | radio0 or radio1. Same reason — STA mode only. |
| **Legacy APs only** (no MLO) | ~4 per radio | `wifi reload` OK for each addition. No EDCCA risk. |
| Legacy AP + STA uplink on same radio | 1 STA per radio | radio0 or radio1 only. |
| Legacy AP + STA uplink on different radio | 1 STA | Fine. |
| Legacy AP + WDS bridge | 1 WDS | radio0 or radio1. |
| Legacy AP + L2 relayd | 1 | radio0 or radio1. |
| **MLO STA** (WiFi 7 uplink, all 3 bands) | 1 | Connects to an upstream MLO AP. |
| MLO STA + legacy APs | ~4 per radio | No EDCCA limit — MLO STA is not an AP, does not use MBSSID. |
| MLO STA + STA uplink | ❌ | Cannot run two uplink sessions simultaneously. |
| **Repeater** (L3 NAT) | 1 | STA on one radio + local AP on a **different** radio. |
| Repeater + existing APs | ✅ | Local AP radio must not be at its MLO limit. |
| **WDS bridge** | 1 | radio0 or radio1. 4-address mode. |
| **L2 relayd** | 1 | radio0 or radio1. ARP proxy — clients get upstream IP. |

#### Not supported

| Combination | Reason |
|-------------|--------|
| MLO AP + MLO STA | Same 3 radios cannot be AP-MLD and STA-MLD simultaneously. |
| MLO AP + 2 or more extra APs on the same radio | EDCCA driver crash. Wizard blocks this. |
| 6 GHz STA (non-MLO) | MT7996 driver limitation — see above. |
| Multiple MLO AP groups | Single chip (one wiphy) — only one MLO group per router. |
| Repeater where STA and local AP share the same radio | Wizard blocks this. |
| WDS or relayd uplink on a radio that is part of an MLO group | Driver cannot run an MLO STA link and a standalone STA (WDS/relayd) on the same radio simultaneously. Wizard blocks this. |
| Two MLO STA connections simultaneously | Only one MLO STA per router — same 3 radios, same wpa_supplicant instance. Wizard blocks this. |

---

## Known limitations

| Limitation | Details |
|------------|---------|
| **6G STA (non-MLO)** | Not supported. The MT7996 driver always routes band2 (6G) through the MLD code path — a standalone 6G STA scan returns no results. 6G uplink is only accessible via MLO STA mode. |
| **MLO AP + MLO STA simultaneously** | Cannot run both on the same router — they share the same three radios. The wizard blocks this with an inline error. |
| **MLO radio AP limit** | Each radio participating in an MLO group can have at most 1 additional legacy AP. Adding a second one via `wifi reload` triggers an EDCCA crash in the MT7996 driver (see below). The wizard enforces this limit and always reboots when adding an AP to an MLO radio. |
| **Per-link RSSI on secondary MLO links** | MT7996 driver reports signal only for the primary data link. Secondary links show `—`. Driver limitation, not fixable in software. |
| **6G channel utilization** | Always reported as `n/a` — driver bug: `mbssid=1` causes hostapd to report 126% utilization. Discarded in layer2. |
| **Repeater radio constraint** | The STA (uplink) and local AP must use different radios. Using the same radio for both is blocked by the wizard. |

---

## Recovery: WiFi completely dead after adding a network

If all WiFi interfaces disappear and nothing comes back after reboot or power cycle, the MT7996 MCU has likely entered a stuck state due to an EDCCA driver crash.

**Symptom:** `dmesg` shows:
```
mt7996e: Failed to start patch
mt7996e: Failed to release patch semaphore
mt7996e: probe with driver mt7996e failed with error -11
```

**Cause:** The MT7996 chip contains an internal MCU with a hardware semaphore register. An EDCCA crash (triggered by adding too many interfaces to an MLO radio via `wifi reload`) can leave this register stuck. The state survives soft reboots and short power cycles because on-board capacitors keep the chip powered for several seconds after shutdown.

**Fix:** Disconnect the router from power for **at least 15 minutes**. This fully discharges the board capacitors and resets all MCU hardware registers. WiFi will initialize normally on the next boot.

> The wizard now prevents the conditions that cause this crash. If you configure networks exclusively through WiFi Manager, you should never encounter this issue.

---

## Requirements

- OpenWrt with **MediaTek SDK (MTK SDK)** — kernel 6.12.x, MT7996 firmware, mt76 driver
- Board: Banana Pi BPI-R4 or BPI-R4 PoE (MT7988A / MT7996)
- LuCI installed

Not compatible with mainline OpenWrt due to differences in interface naming (`ap-mld-*`), MLD UCI configuration, and hostapd vendor extensions.

---

## Changelog

### v3.0.0 (2026-05-28)

**New: Link Policy tab — MLO band steering + traffic steering**

- **`mlo-steerd` daemon** — open-source MLO link steering daemon, deployed to `/root/mlo-steerd.sh`, autostarted via procd with respawn on crash.
- **Band steering (SET_ATTLM)** — weighted algorithm (SNR 60% + tx_retries 30% + channel_busy 10%) with hard SNR gates and 30-second cooldown. Disables underperforming links via AP-side A-TTLM; re-enables when conditions improve.
- **Traffic steering (Neg-TTLM)** — for MLMR clients, maps traffic classes (VO/VI/BE/BK) to optimal links. Voice → 5G only; Video → 5G+6G; BE → all links; BK → 2.4G+5G. Hardware-verified on MT7996.
- **Manual override** — three-button selector in UI: Auto / All links ON / 5G only. Written to UCI, no daemon restart needed.
- **Live dashboard** — noise floor per band, per-client EMLSR/MLMR type, per-link signal, active Neg-TTLM mapping per AC, daemon log (last 25 lines).
- **EMLSR support** — correctly detects single-radio clients (iPhone); applies band steering only, skips Neg-TTLM.

### v2.0.0 (2026-05-16)

**New features**

- **Channel advisor** — "Scan channels" button in each radio card. Scans nearby APs and survey noise, computes interference-weighted score, and recommends top 3 channels as color-coded buttons (green/yellow/red). Click to apply immediately.
- **Scan in wizards** — Station, WDS, and Repeater wizards now have a live scan button that lists nearby networks. Selecting one auto-fills SSID and encryption.
- **All-band nearby scan** — Diagnostics "Nearby Networks" now scans all three bands simultaneously via `uplink_scan_all()` instead of a single radio.
- **Version badge** — UI header shows current package version.

**Safety / crash protection**

- **EDCCA crash prevention in wizardAP** — Radios that are part of an MLO group and already have one legacy AP are disabled in the selector ("— at limit") and show a blocking error. Prevents a class of MT7996 driver crash that requires 15+ minutes of power-off to recover from.
- **EDCCA crash prevention in wizardMLO** — Link toggle buttons for radios already in an existing MLO group are disabled. Shows blocking error if fewer than 2 radios are available.
- **MLO radio always reboots** — wizard_ap() detects if the target radio is part of an MLO group and triggers a reboot instead of `wifi reload`, eliminating the risk of EDCCA crash even if the UI guard is bypassed.
- **MLO conflict blocking in wizardStation** — MLO STA mode is blocked if a local MLO AP or another MLO STA is already active on the same radios.
- **MLO conflict blocking in wizardWDS / wizardRepeater** — Radios that are part of any MLO group (AP or STA) are disabled as uplink options. The driver cannot run an MLO link and a standalone STA (WDS/relayd) on the same radio simultaneously.

**Bug fixes**

- Fixed misleading "DFS scan in progress" message shown on 2.4G interfaces (which have no DFS).
- Fixed TX power display in Radios tab — manual mode now shows the configured UCI value instead of the driver-reported regulatory maximum.
- Fixed scan interface selection — channel advisor and uplink scan now correctly derive the phy interface from radio_id instead of always using `phy0.0-ap0`.

---

### v1.1.1 (2026-05-14)

- Sysupgrade to OpenWrt 99211b26fb (kernel 6.12.x, MTK SDK May 2026)
- First-run UCI defaults (country=CZ, renamed default SSID)
- Hotplug TX power fix for MT7996 cold-boot TMAC=0 bug on band0/band2

### v1.0.0 (2026-05-10)

- Initial public release
- All wizards: MLO AP, legacy AP, Station (incl. MLO STA), WDS, relayd, Repeater, Country
- Networks / Radios / Clients / Diagnostics tabs
- TX power modes: Regulatory / eFuse max / Manual
- Channel utilization, noise, thermal, MLO internals in Diagnostics

---

## License

GPL-2.0-or-later — see [LICENSE](LICENSE). Copyright (c) 2026 Petr Wozniak.
