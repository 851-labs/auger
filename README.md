<div align="center">
  <img width="160" height="160" src="assets/icon.png" alt="Auger icon">
  <h1>Auger</h1>
  <p>A lightweight, self-hosted HTTP tunnel. Think ngrok, but yours.</p>
</div>

<div align="center">
  <img src="https://img.shields.io/badge/Bun-runtime-000000?logo=bun&logoColor=white&style=flat" alt="Bun runtime">
  <img src="https://img.shields.io/badge/Node-20%2B-3c873a?logo=node.js&logoColor=white&style=flat" alt="Node 20+">
  <a href="https://www.npmjs.com/package/@851-labs/auger">
    <img src="https://img.shields.io/npm/v/@851-labs/auger?label=NPM&style=flat" alt="NPM package">
  </a>
  <a href="https://github.com/851-labs/homebrew-tap">
    <img src="https://img.shields.io/badge/Homebrew-851--labs%2Ftap-fbb040?logo=homebrew&logoColor=white&style=flat" alt="Homebrew tap">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT License">
  </a>
</div>

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

Multiple ports:

```bash
auger http 3000 3001 3002
```

Custom subdomains (single port):

```bash
auger http 3000 --subdomain test
auger http 3000:test
```

The `--subdomain` flag only works with a single port. For multiple tunnels, use `<port>:<subdomain>` per entry.

## Other installation options:

Requires Node 20+ for global installs, `bunx`, `npx`, and `pnpm dlx`.

<details>
<summary>npm</summary>

Install:

```bash
npm install -g @851-labs/auger
```

Use:

```bash
auger init
auger http 3000
```

</details>

<details>
<summary>pnpm</summary>

Install:

```bash
pnpm add -g @851-labs/auger
```

Use:

```bash
auger init
auger http 3000
```

</details>

<details>
<summary>bun</summary>

Install:

```bash
bun add -g @851-labs/auger
```

Use:

```bash
auger init
auger http 3000
```

</details>

<br>

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

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/4oDKBx?referralCode=NN7dxz&utm_medium=integration&utm_source=template&utm_campaign=generic)

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
