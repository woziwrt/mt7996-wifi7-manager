# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 Petr Wozniak <petr.wozniak@gmail.com>

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifimgr
PKG_VERSION:=3.0.0
PKG_RELEASE:=20260528

LUCI_TITLE:=LuCI WiFi Manager for BPI-R4 (MT7988A / WiFi 7)
LUCI_DESCRIPTION:=LuCI WiFi manager for OpenWrt on BPI-R4 (MT7988A, WiFi 7, MLO). Provides Network > WiFi Manager with tabs for Overview, Radios, Networks, Uplink, Clients and Diagnostics. Requires OpenWrt with MT7996 support and MLO-capable hostapd.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
PKG_MAINTAINER:=Petr Wozniak <petr.wozniak@gmail.com>
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-wifimgr/postinst
#!/bin/sh
# Stamp the package version into the WebUI top-bar label.
# Single source of truth = PKG_VERSION above; bumping it updates the UI automatically.
sed -i 's/@@PKG_VERSION@@/$(PKG_VERSION)/' \
	"$${IPKG_INSTROOT}/www/luci-static/resources/view/wifimgr/index.js" 2>/dev/null
[ -x "$${IPKG_INSTROOT}/etc/init.d/mlo-steerd" ] && \
	"$${IPKG_INSTROOT}/etc/init.d/mlo-steerd" enable
# First-boot defaults (country + factory SSID security) run from a late init.d
# service so the wireless config already exists when it runs.
[ -x "$${IPKG_INSTROOT}/etc/init.d/wifimgr-defaults" ] && \
	"$${IPKG_INSTROOT}/etc/init.d/wifimgr-defaults" enable
exit 0
endef

# call BuildPackage - OpenWrt buildroot signature
