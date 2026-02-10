#!/bin/bash

# JMS Gateway Cloudflare Workers Deployment Script (KV Edition)
# YAML stored in Cloudflare KV, no external hosting needed

set -e

echo "🚀 JMS Gateway Cloudflare Workers Deployment Tool (KV Edition)"
echo "=================================================="
echo ""

# Check wrangler
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not installed"
    echo "Please run: npm install -g wrangler"
    exit 1
fi

# Check login status
if ! wrangler whoami &> /dev/null; then
    echo "🔑 Please login to Cloudflare first"
    wrangler login
fi

echo "✓ Wrangler is ready"
echo ""

# Check if KV namespace exists
echo "🔍 Checking KV namespace..."
KV_LIST=$(wrangler kv:namespace list 2>/dev/null || echo "[]")
KV_EXISTS=$(echo "$KV_LIST" | grep -o '"title": "YAML_STORAGE"' || true)

if [ -z "$KV_EXISTS" ]; then
    echo "📦 Creating KV namespace..."
    wrangler kv:namespace create "YAML_STORAGE"
    echo ""
    echo "⚠️ Please copy the KV ID above and update the id field in wrangler.toml"
    echo "Then run this script again"
    exit 0
else
    echo "✓ KV namespace already exists"
fi

echo ""

# Read configuration
echo "📋 Please enter configuration information:"
echo ""

# Check YAML file
if [ -f "../proxy.yaml" ]; then
    DEFAULT_YAML="../proxy.yaml"
elif [ -f "./proxy.yaml" ]; then
    DEFAULT_YAML="./proxy.yaml"
else
    DEFAULT_YAML=""
fi

if [ -n "$DEFAULT_YAML" ]; then
    read -p "YAML file path [$DEFAULT_YAML]: " yaml_path
    yaml_path=${yaml_path:-$DEFAULT_YAML}
else
    read -p "YAML file path: " yaml_path
fi

if [ ! -f "$yaml_path" ]; then
    echo "❌ YAML file does not exist: $yaml_path"
    exit 1
fi

read -p "Traffic API URL: " traffic_url

# Generate random Token
token=$(openssl rand -base64 32)
echo ""
echo "🔐 Generated access Token: $token"
echo ""

# Upload YAML to KV
echo "📤 Uploading YAML to KV..."
wrangler kv:key put --binding=YAML_STORAGE "proxy_yaml" --path="$yaml_path"

# Deploy Worker
echo ""
echo "🚀 Deploying Worker..."
wrangler deploy

# Set Secrets
echo ""
echo "🔒 Setting environment variables..."
echo "$traffic_url" | wrangler secret put TRAFFIC_URL
echo "$token" | wrangler secret put ACCESS_TOKEN

# Get Worker URL
echo ""
echo "📎 Getting Worker URL..."
WORKER_INFO=$(wrangler info --json 2>/dev/null || echo '{}')
WORKER_HOST=$(echo "$WORKER_INFO" | grep -o '"host": "[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$WORKER_HOST" ]; then
    WORKER_HOST="your-worker.your-subdomain.workers.dev"
fi

echo ""
echo "=================================================="
echo "✅ Deployment complete!"
echo ""
echo "📎 Subscription URL:"
echo "   https://$WORKER_HOST/subscribe?token=$token"
echo ""
echo "⚠️  Please save the above URL and Token, do not share with others"
echo ""
echo "📝 To update YAML later:"
echo "   wrangler kv:key put --binding=YAML_STORAGE \"proxy_yaml\" --path=./new.yaml"
echo "=================================================="
