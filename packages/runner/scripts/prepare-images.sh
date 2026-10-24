#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${HOME}/.cache/gotchu-runner"
LOCK_FILE="${PACKAGE_DIR}/images.lock.json"
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
FC_ARCHIVE="${CACHE_DIR}/firecracker-v${FC_VERSION}-x86_64.tgz"

curl --fail --location --silent --show-error "${FC_URL}.sha256.txt" -o "${WORK_DIR}/firecracker.sha256.txt"
PUBLISHED_FC_SHA="$(awk '{print $1}' "${WORK_DIR}/firecracker.sha256.txt")"
[[ "${PUBLISHED_FC_SHA}" == "${FC_SHA}" ]] || { echo "Pinned Firecracker SHA-256 differs from the official published checksum" >&2; exit 1; }

if [[ ! -f "${FC_ARCHIVE}" ]]; then curl --fail --location --silent --show-error "${FC_URL}" -o "${FC_ARCHIVE}.tmp"; mv "${FC_ARCHIVE}.tmp" "${FC_ARCHIVE}"; fi
echo "${FC_SHA}  ${FC_ARCHIVE}" | sha256sum --check --status || { echo "Firecracker archive SHA-256 mismatch" >&2; exit 1; }
tar -xzf "${FC_ARCHIVE}" -C "${WORK_DIR}"
install -m 0755 "${WORK_DIR}/release-v${FC_VERSION}-x86_64/firecracker-v${FC_VERSION}-x86_64" "${CACHE_DIR}/firecracker-v${FC_VERSION}-x86_64"
install -m 0755 "${WORK_DIR}/release-v${FC_VERSION}-x86_64/jailer-v${FC_VERSION}-x86_64" "${CACHE_DIR}/jailer-v${FC_VERSION}-x86_64"
FC_BINARY_SHA="$(sha256sum "${CACHE_DIR}/firecracker-v${FC_VERSION}-x86_64" | cut -d ' ' -f 1)"
JAILER_SHA="$(sha256sum "${CACHE_DIR}/jailer-v${FC_VERSION}-x86_64" | cut -d ' ' -f 1)"
EXPECTED_FC_SHA="$(read_lock 'firecracker.binarySha256')"
EXPECTED_JAILER_SHA="$(read_lock 'firecracker.jailerSha256')"
[[ "${FC_BINARY_SHA}" == "${EXPECTED_FC_SHA}" && "${JAILER_SHA}" == "${EXPECTED_JAILER_SHA}" ]] || { echo "Firecracker binaries do not match their pinned release hashes" >&2; exit 1; }

KERNEL="${CACHE_DIR}/vmlinux-${KERNEL_VERSION}"
if [[ ! -f "${KERNEL}" ]]; then curl --fail --location --silent --show-error "${KERNEL_URL}" -o "${KERNEL}.tmp"; mv "${KERNEL}.tmp" "${KERNEL}"; fi
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
find "${WORK_DIR}/rootfs" -exec touch -h -d '@1700000000' {} +

ROOTFS="${CACHE_DIR}/rootfs.ext4"
truncate -s 1G "${ROOTFS}"
E2FSPROGS_FAKE_TIME=1700000000 SOURCE_DATE_EPOCH=1700000000 mkfs.ext4 -q -F -d "${WORK_DIR}/rootfs" \
  -U 01f07786-7c9e-4c96-b786-d616c0fbe0d4 -E lazy_itable_init=0,lazy_journal_init=0,hash_seed=40bbeb80-6617-46d6-83ca-3e91a38995ef \
  "${ROOTFS}"
E2FSPROGS_FAKE_TIME=1700000000 node "${PACKAGE_DIR}/scripts/normalize-rootfs.mjs" "${ROOTFS}"
ROOTFS_SHA="$(sha256sum "${ROOTFS}" | cut -d ' ' -f 1)"
node -e "const fs=require('node:fs');const p=process.argv[1];const x=JSON.parse(fs.readFileSync(p,'utf8'));x.rootfs.sha256=process.argv[2];fs.writeFileSync(p,JSON.stringify(x,null,2)+'\\n')" "${LOCK_FILE}" "${ROOTFS_SHA}"
echo "Prepared rootfs SHA-256: ${ROOTFS_SHA}"
