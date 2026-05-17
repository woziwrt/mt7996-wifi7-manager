include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifimgr
PKG_VERSION:=2.0.0
PKG_RELEASE:=20260517

LUCI_TITLE:=LuCI WiFi Manager for BPI-R4 (MT7988A / WiFi 7)
LUCI_DESCRIPTION:=LuCI WiFi manager for OpenWrt on BPI-R4 (MT7988A, WiFi 7, MLO). Provides Network > WiFi Manager with tabs for Overview, Radios, Networks, Uplink, Clients and Diagnostics. Requires OpenWrt with MT7996 support and MLO-capable hostapd.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
PKG_MAINTAINER:=woziwrt <https://github.com/woziwrt>
PKG_LICENSE:=MIT

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
