#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${GOTCHU_RUNNER_CACHE_DIR:-${HOME}/.cache/gotchu-runner}"
LOCK_FILE="${PACKAGE_DIR}/images.lock.json"
PIN_IMAGES="${1:-}"
if [[ -n "${PIN_IMAGES}" && "${PIN_IMAGES}" != "--pin" ]]; then echo "Usage: prepare-images.sh [--pin]" >&2; exit 2; fi
mkdir -p "${CACHE_DIR}"
WORK_DIR="$(mktemp -d "${CACHE_DIR}/build.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT

read_lock() {
  node -e "const x=require(process.argv[1]); console.log(x.${1})" "${LOCK_FILE}"
}

FC_VERSION="$(read_lock 'firecracker.version')"
FC_URL="$(read_lock 'firecracker.archiveUrl')"
FC_SHA="$(read_lock 'firecracker.archiveSha256')"
KERNEL_URL="$(read_lock 'kernel.url')"
KERNEL_VERSION="$(read_lock 'kernel.version')"
KERNEL_SHA="$(read_lock 'kernel.sha256')"
NODE_IMAGE="$(read_lock 'rootfs.baseImage')"
FC_ARCHIVE="${CACHE_DIR}/firecracker-${FC_SHA}.tgz"

curl --fail --location --silent --show-error "${FC_URL}.sha256.txt" -o "${WORK_DIR}/firecracker.sha256.txt"
PUBLISHED_FC_SHA="$(awk '{print $1}' "${WORK_DIR}/firecracker.sha256.txt")"
[[ "${PUBLISHED_FC_SHA}" == "${FC_SHA}" ]] || { echo "Pinned Firecracker SHA-256 differs from the official published checksum" >&2; exit 1; }

if [[ ! -f "${FC_ARCHIVE}" ]]; then
  curl --fail --location --silent --show-error "${FC_URL}" -o "${WORK_DIR}/firecracker.tgz"
  echo "${FC_SHA}  ${WORK_DIR}/firecracker.tgz" | sha256sum --check --status || { echo "Firecracker archive SHA-256 mismatch" >&2; exit 1; }
  ln "${WORK_DIR}/firecracker.tgz" "${FC_ARCHIVE}" 2>/dev/null || true
fi
echo "${FC_SHA}  ${FC_ARCHIVE}" | sha256sum --check --status || { echo "Firecracker archive SHA-256 mismatch" >&2; exit 1; }
tar -xzf "${FC_ARCHIVE}" -C "${WORK_DIR}"
EXPECTED_FC_SHA="$(read_lock 'firecracker.binarySha256')"
EXPECTED_JAILER_SHA="$(read_lock 'firecracker.jailerSha256')"
FC_BINARY="${CACHE_DIR}/firecracker-${EXPECTED_FC_SHA}"
JAILER_BINARY="${CACHE_DIR}/jailer-${EXPECTED_JAILER_SHA}"
if [[ ! -f "${FC_BINARY}" ]]; then install -m 0755 "${WORK_DIR}/release-v${FC_VERSION}-x86_64/firecracker-v${FC_VERSION}-x86_64" "${WORK_DIR}/firecracker"; ln "${WORK_DIR}/firecracker" "${FC_BINARY}" 2>/dev/null || true; fi
if [[ ! -f "${JAILER_BINARY}" ]]; then install -m 0755 "${WORK_DIR}/release-v${FC_VERSION}-x86_64/jailer-v${FC_VERSION}-x86_64" "${WORK_DIR}/jailer"; ln "${WORK_DIR}/jailer" "${JAILER_BINARY}" 2>/dev/null || true; fi
FC_BINARY_SHA="$(sha256sum "${FC_BINARY}" | cut -d ' ' -f 1)"
JAILER_SHA="$(sha256sum "${JAILER_BINARY}" | cut -d ' ' -f 1)"
[[ "${FC_BINARY_SHA}" == "${EXPECTED_FC_SHA}" && "${JAILER_SHA}" == "${EXPECTED_JAILER_SHA}" ]] || { echo "Firecracker binaries do not match their pinned release hashes" >&2; exit 1; }

KERNEL="${CACHE_DIR}/vmlinux-${KERNEL_SHA}"
if [[ ! -f "${KERNEL}" ]]; then curl --fail --location --silent --show-error "${KERNEL_URL}" -o "${WORK_DIR}/vmlinux"; ln "${WORK_DIR}/vmlinux" "${KERNEL}" 2>/dev/null || true; fi
echo "${KERNEL_SHA}  ${KERNEL}" | sha256sum --check --status || { echo "Guest kernel SHA-256 mismatch" >&2; exit 1; }

if [[ "${NODE_IMAGE}" != *@sha256:* ]]; then echo "Node rootfs must be pinned by digest" >&2; exit 1; fi
docker pull "${NODE_IMAGE}"
CONTAINER="$(docker create "${NODE_IMAGE}")"
mkdir -p "${WORK_DIR}/rootfs"
docker export "${CONTAINER}" | tar -xf - -C "${WORK_DIR}/rootfs"
docker rm "${CONTAINER}" >/dev/null
mkdir -p "${WORK_DIR}/rootfs/sbin" "${WORK_DIR}/rootfs/usr/local/lib"
install -m 0755 "${PACKAGE_DIR}/guest/init.sh" "${WORK_DIR}/rootfs/sbin/init"
install -m 0644 "${PACKAGE_DIR}/guest/agent.mjs" "${WORK_DIR}/rootfs/usr/local/lib/gotchu-guest-agent.mjs"
install -m 0644 "${PACKAGE_DIR}/guest/selected-node.mjs" "${WORK_DIR}/rootfs/usr/local/lib/selected-node.mjs"
install -m 0644 "${PACKAGE_DIR}/guest/node-selected-reporter.mjs" "${WORK_DIR}/rootfs/usr/local/lib/gotchu-node-selected-reporter.mjs"
node "${PACKAGE_DIR}/scripts/prepare-node-toolchain.mjs" "${WORK_DIR}/rootfs"

# Repack into a sorted, metadata-normalized archive, then extract into a clean
# tree so mkfs sees stable directory-entry order and timestamps.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@1700000000' --no-xattrs --no-acls \
  -cf "${WORK_DIR}/rootfs.tar" -C "${WORK_DIR}/rootfs" .
mkdir "${WORK_DIR}/rootfs-normalized"
tar --no-same-owner --no-xattrs --no-acls -xf "${WORK_DIR}/rootfs.tar" -C "${WORK_DIR}/rootfs-normalized"
rm -rf "${WORK_DIR}/rootfs"
mv "${WORK_DIR}/rootfs-normalized" "${WORK_DIR}/rootfs"
PRIMARY_GID="$(id -g "$(id -un)")"
chgrp -hR "${PRIMARY_GID}" "${WORK_DIR}/rootfs"
find "${WORK_DIR}/rootfs" -exec touch -h -d '@1700000000' {} +

ROOTFS="${WORK_DIR}/rootfs.ext4"
truncate -s 1G "${ROOTFS}"
E2FSPROGS_FAKE_TIME=1700000000 SOURCE_DATE_EPOCH=1700000000 mkfs.ext4 -q -F -d "${WORK_DIR}/rootfs" \
  -U 01f07786-7c9e-4c96-b786-d616c0fbe0d4 -E lazy_itable_init=0,lazy_journal_init=0,hash_seed=40bbeb80-6617-46d6-83ca-3e91a38995ef \
  "${ROOTFS}"
E2FSPROGS_FAKE_TIME=1700000000 node "${PACKAGE_DIR}/scripts/normalize-rootfs.mjs" "${ROOTFS}"
ROOTFS_SHA="$(sha256sum "${ROOTFS}" | cut -d ' ' -f 1)"
ROOTFS_CACHE="${CACHE_DIR}/rootfs-${ROOTFS_SHA}.ext4"
if [[ ! -f "${ROOTFS_CACHE}" ]]; then ln "${ROOTFS}" "${ROOTFS_CACHE}" 2>/dev/null || true; fi
echo "${ROOTFS_SHA}  ${ROOTFS_CACHE}" | sha256sum --check --status || { echo "Cached rootfs digest path contains different or corrupted data; refusing to replace it" >&2; exit 1; }
echo "Built rootfs SHA-256: ${ROOTFS_SHA} (${ROOTFS_CACHE})"
OLD_ROOTFS_SHA="$(read_lock 'rootfs.sha256')"
if [[ "${PIN_IMAGES}" == "--pin" ]]; then
  node -e "const fs=require('node:fs');const p=process.argv[1];const x=JSON.parse(fs.readFileSync(p,'utf8'));x.rootfs.sha256=process.argv[2];fs.writeFileSync(p,JSON.stringify(x,null,2)+'\\n')" "${LOCK_FILE}" "${ROOTFS_SHA}"
  echo "Pinned rootfs SHA-256: ${OLD_ROOTFS_SHA} -> ${ROOTFS_SHA}"
elif [[ "${ROOTFS_SHA}" != "${OLD_ROOTFS_SHA}" ]]; then
  echo "Rootfs SHA-256 mismatch: images.lock.json pins ${OLD_ROOTFS_SHA}, build produced ${ROOTFS_SHA}. Review the change, then run 'pnpm --filter @gotchu/runner pin:images' to update the pin." >&2
  exit 1
fi
