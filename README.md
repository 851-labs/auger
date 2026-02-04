# Auger

A lightweight, self-hosted HTTP tunnel. Think ngrok, but yours.

## Use the CLI

Install (Homebrew):

```bash
brew tap 851-labs/tap
brew install 851-labs/tap/auger
```

Use (Homebrew):

```bash
auger init
auger http 3000
```

You’ll get a public URL like `https://bright-ember.auger.yourdomain.com` that proxies to `http://127.0.0.1:3000`.

## Other installation options:

Requires Node 20+ for `bunx`, `npx`, and `pnpm dlx`.

<details>
<summary>bunx</summary>

Install:

```bash
bunx @851-labs/auger init
```

Use:

```bash
bunx @851-labs/auger http 3000
```

</details>

<details>
<summary>npx</summary>

Install:

```bash
npx @851-labs/auger init
```

Use:

```bash
npx @851-labs/auger http 3000
```

</details>

<details>
<summary>pnpm dlx</summary>

Install:

```bash
pnpm dlx @851-labs/auger init
```

Use:

```bash
pnpm dlx @851-labs/auger http 3000
```

</details>

## Deploy the server

<details>
<summary>Fly.io</summary>

This example pulls the latest published image from GitHub Container Registry.

```toml
# fly.toml
app = "auger"
primary_region = "iad"

[build]
  image = "ghcr.io/851-labs/auger-server:latest"

[env]
  AUGER_BASE_DOMAIN = "auger.example.com" # <- Set this to your root domain.
  AUGER_HTTP_PORT = "8080"
  AUGER_WS_PATH = "/ws"
  AUGER_DB_PATH = "/data/auger.db"
  AUGER_TOKENS = "changeme" # <- Comma-separated auth tokens (use a strong secret).

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
