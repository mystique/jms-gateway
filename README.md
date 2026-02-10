# JMS Gateway - Cloudflare Workers (KV Storage Edition)

YAML configuration is stored in **Cloudflare KV**, no external hosting needed, completely secure subscription service.

## Features

- 🔐 **YAML stored in KV** - No public URL required, fully private
- 🔑 **Token authentication** - Prevent subscription links from being used by others
- 🛡️ **Rate limiting** - Max 30 requests per IP per minute
- 📊 **Traffic info** - Automatically fetch and inject traffic usage information
- 📝 **Access logs** - Record all requests for auditing
- 🚀 **Global acceleration** - Deployed on Cloudflare edge network
- 💰 **Completely free** - Uses Workers + KV free tier

## Architecture

```
Clash Verge → Cloudflare Edge
                   ↓
            [Token verification]
                   ↓
            [Rate limit check]
                   ↓
            [Read YAML from KV]  ← Internal storage, zero external dependencies
                   ↓
            [Fetch traffic info from external source]
                   ↓
            [Return YAML + traffic headers]
```

## Quick Deployment

### Method 1: Wrangler CLI (Recommended)

#### 1. Install Dependencies

```bash
npm install -g wrangler
```

#### 2. Login to Cloudflare

```bash
wrangler login
```

#### 3. Create KV Namespace

```bash
wrangler kv:namespace create "YAML_STORAGE"
```

Output will look like:
```
{ binding = "YAML_STORAGE", id = "xxxxxxxxxxxxxxxx" }
```

#### 4. Update wrangler.toml

Fill in the `id` from the previous step into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "YAML_STORAGE"
id = "xxxxxxxxxxxxxxxx"  # Replace with your ID
```

#### 5. Upload YAML to KV

```bash
# Upload proxy.yaml to KV
wrangler kv:key put --binding=YAML_STORAGE "proxy_yaml" --path=../proxy.yaml
```

Or upload directly in the Dashboard:
- Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
- Workers & Pages → KV → Find your namespace
- Add Key: `proxy_yaml`, Value: (paste YAML content)

#### 6. Deploy Worker

```bash
wrangler deploy
```

#### 7. Set Secrets

```bash
# Set traffic API URL
wrangler secret put TRAFFIC_URL
# Enter: https://your-traffic-api.com/info

# Set access token (recommend 32 character random string)
wrangler secret put ACCESS_TOKEN
# Enter: your-secret-token-here
```

### Method 2: One-Click Deployment Script

#### Windows (PowerShell)

```powershell
.\deploy-kv.ps1
```

#### macOS/Linux (Bash)

```bash
chmod +x deploy-kv.sh
./deploy-kv.sh
```

### Method 3: Manual Dashboard Deployment

1. Login to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Create KV Namespace**:
   - Workers & Pages → KV
   - Create a namespace → Name it `YAML_STORAGE`
3. **Upload YAML**:
   - Enter `YAML_STORAGE`
   - Add entry
   - Key: `proxy_yaml`
   - Value: Paste your YAML content
4. **Create Worker**:
   - Workers & Pages → Create application
   - Create Worker
   - Paste `_worker.js` code
   - Deploy
5. **Bind KV**:
   - Worker Settings → Variables
   - KV Namespace Bindings
   - Add binding: `YAML_STORAGE` → Select your created namespace
6. **Set Secrets**:
   - Settings → Variables and Secrets
   - Add `TRAFFIC_URL` (Secret)
   - Add `ACCESS_TOKEN` (Secret)

## Using the Subscription

After deployment, the subscription URL is:

```
https://your-worker.your-subdomain.workers.dev/subscribe?token=your-secret-token
```

Add this link in Clash Verge.

## Updating YAML

When you need to update the configuration:

```bash
# Update YAML in KV
wrangler kv:key put --binding=YAML_STORAGE "proxy_yaml" --path=./new-proxy.yaml
```

Or directly edit the KV value in the Dashboard.

## Security Features Explained

### Token Authentication

- Uses timing-safe comparison to prevent timing attacks
- Token should be 32+ character random string
- Token can be immediately replaced in the Dashboard if leaked

### Rate Limiting

- Max 30 requests per IP per minute
- Prevents brute force attacks and subscription abuse
- Returns 429 Too Many Requests when exceeded

### Data Flow

| Data | Storage Location | Security |
|------|------------------|----------|
| YAML config | Cloudflare KV | 🔒 Fully private, not exposed externally |
| Access token | Workers Secret | 🔒 Encrypted storage, unreadable by code |
| Traffic API | Workers Secret | 🔒 Encrypted storage, unreadable by code |
| Access logs | Cloudflare Logs | 🔒 Only visible to you |

## Environment Variables

| Variable Name | Type | Description |
|---------------|------|-------------|
| `YAML_STORAGE` | KV Binding | KV namespace binding |
| `TRAFFIC_URL` | Secret | Traffic info API URL |
| `ACCESS_TOKEN` | Secret | Access token |

## Pricing

Completely free:
- Workers: 100,000 requests per day
- KV: 100,000 reads per day, 1,000 writes per day
- For personal subscription use, the free tier is more than sufficient

## Troubleshooting

### 500 Internal Server Error
- Check if `proxy_yaml` key exists in KV
- Check if Secrets are set

### 401 Unauthorized
- Check the `token` parameter in the URL
- Check if `ACCESS_TOKEN` Secret is set

### Traffic info not displaying
- Check if `TRAFFIC_URL` is correct
- Check traffic API response format

### YAML not updating after change
- KV has caching, usually takes effect after a few seconds
- Can check KV value in Dashboard to confirm

## Changelog

### v2.0 (KV Edition)
- Changed YAML storage from external URL to Cloudflare KV
- More secure, no need to publicly host YAML

### v1.0 (URL Edition)
- Basic subscription service
- Token authentication and rate limiting

## License

MIT
