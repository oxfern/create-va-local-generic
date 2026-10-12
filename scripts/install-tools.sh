#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
tools_dir="$PWD/.tools"
downloads_dir="$tools_dir/downloads"
mkdir -p "$tools_dir/bin" "$downloads_dir"

case "$(uname -s)" in
  Darwin) os=darwin; llama_os=macos ;;
  Linux) os=linux; llama_os=ubuntu ;;
  *) echo "Supported systems: macOS and Linux." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) bun_arch=aarch64; node_arch=arm64; llama_arch=arm64 ;;
  x86_64|amd64) bun_arch=x64; node_arch=x64; llama_arch=x64 ;;
  *) echo "Supported CPUs: ARM64 and x86-64." >&2; exit 1 ;;
esac

for command in curl tar unzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing system tool: $command. Install it and run ./start.sh again." >&2
    exit 1
  fi
done

case "$os/$bun_arch" in
  darwin/aarch64) bun_sha=c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381 ;;
  darwin/x64) bun_sha=1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0 ;;
  linux/aarch64) bun_sha=4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e ;;
  linux/x64) bun_sha=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452 ;;
esac
case "$os/$node_arch" in
  darwin/arm64) node_sha=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
  darwin/x64) node_sha=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
  linux/arm64) node_sha=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
  linux/x64) node_sha=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
esac
case "$os/$llama_arch" in
  darwin/arm64) llama_sha=1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711 ;;
  darwin/x64) llama_sha=305f0e3a17d2c01eb205cd0a62128357f1ec3b55329cb084d94e5ec0115d7a3b ;;
  linux/arm64) llama_sha=4aeda6fe68831547e49b7fa87607383ca5352b3d72ca5f70d52ed265f58c131f ;;
  linux/x64) llama_sha=c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410 ;;
esac

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "Missing SHA-256 tool (shasum or sha256sum)." >&2
    exit 1
  fi
}

download_verified() {
  local url="$1" archive="$2" expected="$3" actual
  if [ ! -f "$archive" ] || [ "$(sha256_file "$archive")" != "$expected" ]; then
    echo "Downloading $(basename "$archive")..."
    curl -fL --retry 3 --connect-timeout 30 "$url" -o "$archive"
  fi
  actual="$(sha256_file "$archive")"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $(basename "$archive"). Run ./start.sh again." >&2
    exit 1
  fi
}

if [ ! -x "$tools_dir/bin/bun" ]; then
  bun_name="bun-$os-$bun_arch"
  bun_archive="$downloads_dir/$bun_name.zip"
  download_verified "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/$bun_name.zip" "$bun_archive" "$bun_sha"
  mkdir -p "$tools_dir/bun-1.4.0"
  unzip -q -o "$bun_archive" -d "$tools_dir/bun-1.4.0"
  cp "$tools_dir/bun-1.4.0/$bun_name/bun" "$tools_dir/bin/bun"
  chmod +x "$tools_dir/bin/bun"
fi

if [ ! -x "$tools_dir/bin/node" ]; then
  node_name="node-v22.23.3-$os-$node_arch"
  node_archive="$downloads_dir/$node_name.tar.gz"
  download_verified "https://nodejs.org/dist/v22.23.3/$node_name.tar.gz" "$node_archive" "$node_sha"
  mkdir -p "$tools_dir/node-v22.23.3"
  tar -xzf "$node_archive" -C "$tools_dir/node-v22.23.3" --strip-components=1
  ln -sfn "../node-v22.23.3/bin/node" "$tools_dir/bin/node"
fi

if [ ! -x "$tools_dir/llama-b11146/llama-server" ]; then
  llama_name="llama-b11146-bin-$llama_os-$llama_arch"
  llama_archive="$downloads_dir/$llama_name.tar.gz"
  download_verified "https://github.com/ggml-org/llama.cpp/releases/download/b11146/$llama_name.tar.gz" "$llama_archive" "$llama_sha"
  mkdir -p "$tools_dir/llama-b11146"
  tar -xzf "$llama_archive" -C "$tools_dir/llama-b11146" --strip-components=1
  if [ ! -x "$tools_dir/llama-b11146/llama-server" ]; then
    echo "The llama.cpp archive did not contain llama-server." >&2
    exit 1
  fi
fi

echo "Local tools ready: Bun 1.4.0, Node 22.23.3, llama.cpp b11146."
