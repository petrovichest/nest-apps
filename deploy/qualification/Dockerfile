FROM ubuntu:24.04

ARG CODEX_VERSION
ENV container=docker
ENV PATH=/opt/node/bin:/opt/native/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl dbus-user-session git openssl procps python3 sqlite3 sudo \
    systemd systemd-sysv xz-utils \
    && apt-get clean

RUN mkdir -p /opt/node /opt/native /opt/qualification \
    && curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz -o /opt/node.tar.xz \
    && curl -fsSL https://nodejs.org/dist/v24.18.0/SHASUMS256.txt -o /opt/node-shasums.txt \
    && cd /opt \
    && awk '$2 == "node-v24.18.0-linux-x64.tar.xz" { print $1 "  node.tar.xz" }' node-shasums.txt | sha256sum --check --strict \
    && tar -xJf node.tar.xz --strip-components=1 -C /opt/node \
    && ln -s /opt/node/bin/node /usr/local/bin/node \
    && ln -s /opt/node/bin/npm /usr/local/bin/npm \
    && npm install --prefix /opt/native --ignore-scripts --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && npm install --prefix /opt/qualification --ignore-scripts --no-audit --no-fund ws@8.21.1 \
    && ln -s /opt/native/node_modules/.bin/codex /usr/local/bin/codex \
    && codex --version | grep -Fx "codex-cli ${CODEX_VERSION}" \
    && dpkg-query -W > /opt/qualification/packages.txt

RUN useradd --create-home --uid 17001 --shell /bin/bash nest-qualification \
    && printf 'nest-qualification ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/nest-qualification \
    && chmod 0440 /etc/sudoers.d/nest-qualification \
    && systemctl mask systemd-remount-fs.service getty.target \
    && truncate -s 0 /etc/machine-id

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
