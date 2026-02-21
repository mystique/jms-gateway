# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Deploy to Cloudflare Workers
wrangler deploy

# Local development
wrangler dev

# Upload YAML config to KV
wrangler kv:key put --binding=YAML_STORAGE "proxy_yaml" --path=./proxy.yaml

# Set secrets
wrangler secret put ACCESS_TOKEN
wrangler secret put TRAFFIC_URL
```

## Architecture

Single-file Cloudflare Worker (`_worker.js`) that serves as a private proxy subscription gateway.

Request flow: rate limit check → auth failure ban check → token auth → KV read → traffic fetch → response

Key design points:
- YAML config is stored Base64-encoded in Cloudflare KV under key `proxy_yaml`; the worker decodes it before serving
- `ACCESS_TOKEN` is a Workers Secret (never in `wrangler.toml`); use `.dev.vars` locally (see `.dev.vars.example`)
- Traffic bytes from the JMS API are 1000-based; `convertTo1024Display()` adjusts them so Clash clients show correct decimal GB values
- Rate limiting and auth-fail tracking use in-memory `Map`s — state resets on worker restart/cold start
- The only valid endpoint is `GET /subscribe?token=<ACCESS_TOKEN>`

## Environment Variables

| Variable | Type | Required |
|---|---|---|
| `YAML_STORAGE` | KV Binding | Yes |
| `ACCESS_TOKEN` | Secret | Yes |
| `TRAFFIC_URL` | Secret/Var | No |
| `DOWNLOAD_FILENAME` | Var | No (default: `JMS`) |
