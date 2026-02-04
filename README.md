# Auger

A lightweight, self-hosted HTTP tunnel. Think ngrok, but yours.

## Install the CLI (from source)

```bash
bun install
bun run build:cli
./packages/cli/dist/index.js init
```

## Use the tunnel

```bash
auger http 3000
```

You’ll get a public URL like `https://bright-ember.auger.yourdomain.com` that proxies to `http://127.0.0.1:3000`.

## Deploy the server

<details>
<summary>Fly.io</summary>

This example pulls the latest published image from GitHub Container Registry.

```toml
# fly.toml
app = "auger"
primary_region = "iad"
image = "ghcr.io/851-labs/auger-server:latest"

[env]
  AUGER_BASE_DOMAIN = "auger.example.com"
  AUGER_HTTP_PORT = "8080"
  AUGER_WS_PATH = "/ws"
  AUGER_DB_PATH = "/data/auger.db"
  AUGER_TOKENS = "changeme"

[[mounts]]
  source = "auger_data"
  destination = "/data"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

Then run:

```bash
fly launch
```

Make sure to configure DNS for `AUGER_BASE_DOMAIN` and `*.AUGER_BASE_DOMAIN`.

</details>
