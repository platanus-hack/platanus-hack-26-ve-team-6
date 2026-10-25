FROM docker.io/library/node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae

COPY scripts/prepare-node-toolchain.mjs /build/scripts/prepare-node-toolchain.mjs
COPY guest/node-toolchain.lock.json /build/guest/node-toolchain.lock.json
RUN node /build/scripts/prepare-node-toolchain.mjs / \
    && rm -rf /build /tmp \
    && ln -s /scratch/tmp /tmp
COPY guest/selected-node.mjs /usr/local/lib/selected-node.mjs
COPY guest/node-selected-reporter.mjs /usr/local/lib/gotchu-node-selected-reporter.mjs
COPY guest/docker-agent.mjs /usr/local/lib/gotchu-docker-agent.mjs
ENV HOME=/scratch/home TMPDIR=/scratch/tmp
WORKDIR /scratch
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "/usr/local/lib/gotchu-docker-agent.mjs"]
