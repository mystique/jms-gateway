# JMS Gateway Cloudflare Workers Deployment Script (KV Edition)
# YAML stored in Cloudflare KV, no external hosting needed

Write-Host "🚀 JMS Gateway Cloudflare Workers Deployment Tool (KV Edition)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Check wrangler
$wrangler = Get-Command wrangler -ErrorAction SilentlyContinue
if (-not $wrangler) {
    Write-Host "❌ Wrangler CLI not installed" -ForegroundColor Red
    Write-Host "Please run: npm install -g wrangler"
    exit 1
}

# Check login status
try {
    $null = wrangler whoami 2>$null
} catch {
    Write-Host "🔑 Please login to Cloudflare first" -ForegroundColor Yellow
    wrangler login
}

Write-Host "✓ Wrangler is ready" -ForegroundColor Green
Write-Host ""

# Check if wrangler.toml has KV configured
$wranglerContent = Get-Content "./wrangler.toml" -Raw
if ($wranglerContent -match "your_kv_namespace_id_here") {
    Write-Host "📦 KV namespace not configured" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "First deployment requires creating a KV namespace:" -ForegroundColor Cyan
    Write-Host "  1. Run: wrangler kv:namespace create `"YAML_STORAGE`"" -ForegroundColor White
    Write-Host "  2. Copy the output ID" -ForegroundColor White
    Write-Host "  3. Update the id field in wrangler.toml" -ForegroundColor White
    Write-Host "  4. Run this script again" -ForegroundColor White
    exit 0
}

Write-Host "✓ KV configuration is ready" -ForegroundColor Green
Write-Host ""

# Read configuration
Write-Host "📋 Please enter configuration information:" -ForegroundColor Cyan
Write-Host ""

# Check YAML file
$defaultYaml = ""
if (Test-Path "../proxy.yaml") {
    $defaultYaml = "../proxy.yaml"
} elseif (Test-Path "./proxy.yaml") {
    $defaultYaml = "./proxy.yaml"
}

if ($defaultYaml) {
    $yamlPath = Read-Host "YAML file path [$defaultYaml]"
    if ([string]::IsNullOrWhiteSpace($yamlPath)) {
        $yamlPath = $defaultYaml
    }
} else {
    $yamlPath = Read-Host "YAML file path"
}

if (-not (Test-Path $yamlPath)) {
    Write-Host "❌ YAML file does not exist: $yamlPath" -ForegroundColor Red
    exit 1
}

$trafficUrl = Read-Host "Traffic API URL"

# Generate random Token
$bytes = New-Object byte[] 24
$rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
$rng.GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes)

Write-Host ""
Write-Host "🔐 Generated access Token: $token" -ForegroundColor Yellow
Write-Host ""

# Upload YAML to KV
Write-Host "📤 Uploading YAML to KV..." -ForegroundColor Cyan
wrangler kv:key put --binding=YAML_STORAGE "proxy_yaml" --path="$yamlPath"

# Deploy Worker
Write-Host ""
Write-Host "🚀 Deploying Worker..." -ForegroundColor Cyan
wrangler deploy

# Set Secrets
Write-Host ""
Write-Host "🔒 Setting environment variables..." -ForegroundColor Cyan
$trafficUrl | wrangler secret put TRAFFIC_URL
$token | wrangler secret put ACCESS_TOKEN

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "✅ Deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📎 Subscription URL format:" -ForegroundColor Cyan
Write-Host "   https://<your-worker-address>/subscribe?token=$token" -ForegroundColor White
Write-Host ""
Write-Host "⚠️  Please save the Token and do not share with others" -ForegroundColor Yellow
Write-Host ""
Write-Host "📝 To update YAML later:" -ForegroundColor Cyan
Write-Host "   wrangler kv:key put --binding=YAML_STORAGE `"proxy_yaml`" --path=./new.yaml" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor Green

Read-Host "`nPress Enter to exit"
