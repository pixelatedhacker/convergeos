const ENTRYPOINT = `#!/bin/sh
set -eu

mkdir -p "$XDG_CONFIG_HOME/openbox" "$XDG_CACHE_HOME"
Xvfb :0 -screen 0 1440x900x24 -nolisten tcp &
openbox-session &
pcmanfm --desktop --profile LXDE &
xterm -geometry 120x36+24+24 &
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --user-data-dir=/home/bot/.config/chromium about:blank &
x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900 &
exec websockify --web=/usr/share/novnc 6080 localhost:5900
`;

const entrypointBase64 = Buffer.from(ENTRYPOINT, "utf8").toString("base64");

export const BOT_COMPUTER_DOCKERFILE = `FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install --no-install-recommends -y \\
      ca-certificates chromium dbus-x11 fonts-dejavu-core novnc openbox pcmanfm scrot tini websockify x11vnc xdotool xterm xvfb \\
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/sh bot \\
 && mkdir -p /workspace /home/bot/.config/chromium \\
 && chown -R bot:bot /workspace /home/bot

RUN echo '${entrypointBase64}' | base64 -d > /usr/local/bin/start-bot-computer \\
 && chmod 0755 /usr/local/bin/start-bot-computer

ENV DISPLAY=:0 \\
    HOME=/home/bot \\
    XDG_CACHE_HOME=/home/bot/.cache \\
    XDG_CONFIG_HOME=/tmp/config

EXPOSE 6080
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-bot-computer"]
`;
