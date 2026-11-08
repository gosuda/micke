#!/bin/sh
# install — one command to a background micke on macOS and Linux.
#
# WHY a shell installer: the whole product is one raw binary plus a service
# registration, so the install is download → verify → move → register. Doing
# it in POSIX sh keeps the curl|sh path dependency-free (curl and a sha256
# tool are everywhere), and re-running the script IS the upgrade path: the
# binary lands at the same path and `micke service install` bounces the
# registration into the new build, with sessions surviving the bounce.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gosuda/micke/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/gosuda/micke/main/install.sh | sh -s -- v0.2.0
#
# Overridables (mirrors, air-gapped hosts, custom prefix):
#   MICKE_REPO           GitHub repo to install from   (default gosuda/micke)
#   MICKE_RELEASE_BASE   full releases URL base        (default https://github.com/$MICKE_REPO/releases)
#   MICKE_BIN_DIR        install prefix                (default ~/.local/bin)
#   MICKE_VERSION        tag to install                (default latest; $1 wins)
set -eu

die() { echo "micke: $*" >&2; exit 1; }
say() { echo "micke: $*"; }
warn() { echo "micke: $*" >&2; }

repo=${MICKE_REPO:-gosuda/micke}
base=${MICKE_RELEASE_BASE:-https://github.com/$repo/releases}
bin_dir=${MICKE_BIN_DIR:-"${HOME:-.}/.local/bin"}
tag=${1:-${MICKE_VERSION:-latest}}

[ -n "${HOME:-}" ] || die "\$HOME is not set — no default for MICKE_BIN_DIR"
command -v curl >/dev/null 2>&1 || die "curl is required (it resolves, downloads and verifies the release)"

os=$(uname -s)
case "$os" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) die "unsupported OS \"$os\" — on Windows use install.ps1 (see the README)" ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported CPU \"$machine\" — no micke release for it" ;;
esac

# gvx, micke's only runtime, publishes no darwin-amd64 build — neither do we.
if [ "$platform" = darwin ] && [ "$arch" = amd64 ]; then
  die "no darwin-amd64 release; micke on macOS is Apple Silicon only"
fi

if [ "$tag" = latest ]; then
  # $base/latest (on GitHub: .../<repo>/releases/latest — $base already ends in
  # /releases) 302s to <base>/tag/<tag>; with -L curl ends up on the tag page
  # (must be 200 or -f fails) and -w prints the URL it landed on.
  url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$base/latest") \
    || die "could not resolve the latest release from $base/latest"
  tag=${url%/}
  tag=${tag##*/}
  [ -n "$tag" ] || die "no tag in the followed URL: $url"
  say "latest release is $tag"
fi

asset="micke-$tag-$platform-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL -o "$tmp/SHA256SUMS" "$base/download/$tag/SHA256SUMS" \
  || die "could not download $base/download/$tag/SHA256SUMS"
curl -fsSL -o "$tmp/$asset" "$base/download/$tag/$asset" \
  || die "could not download $base/download/$tag/$asset"

expected=$(awk -v f="$asset" '$2==f{print $1}' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS for $tag has no entry for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  got=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
  die "need sha256sum or shasum (sha256) to verify the download"
fi
[ "$got" = "$expected" ] || die "sha256 mismatch for $asset — nothing installed (got $got, want $expected)"
say "verified $asset against the release's SHA256SUMS"

if [ -e "$bin_dir/micke" ]; then
  say "replacing the existing $bin_dir/micke (this run is an upgrade)"
fi
mkdir -p "$bin_dir" || die "cannot create $bin_dir"
mv "$tmp/$asset" "$bin_dir/micke"
chmod 755 "$bin_dir/micke"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) warn "warning: $bin_dir is not on your PATH — add it (or open a new shell) to run micke" ;;
esac

# Register + start; re-running over an existing registration bounces the
# daemon into the new binary. Status is informational on purpose.
"$bin_dir/micke" service install
"$bin_dir/micke" service status || true
echo "micke: dashboard at http://127.0.0.1:7800/ (MICKE_PORT to change)"
