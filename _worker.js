/**
 * JMS Gateway - Cloudflare Workers (KV Storage Edition)
 * YAML config stored in Cloudflare KV, no external hosting needed
 * Features: Token authentication, rate limiting, traffic info injection
 */

// Rate limiting: max 30 requests per IP per minute
const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute in milliseconds
const RATE_LIMIT_MAX = 30; // maximum requests allowed

/**
 * Check rate limit for an IP address
 * @param {string} ip - Client IP address
 * @returns {boolean} - true if allowed, false if rate limited
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  const requests = RATE_LIMIT.get(ip) || [];
  const recentRequests = requests.filter((t) => t > windowStart);

  if (recentRequests.length >= RATE_LIMIT_MAX) {
    return false;
  }

  recentRequests.push(now);
  RATE_LIMIT.set(ip, recentRequests);

  // Cleanup old data occasionally (1% chance)
  if (recentRequests.length === 1 && Math.random() < 0.01) {
    cleanupRateLimit();
  }

  return true;
}

/**
 * Clean up expired rate limit entries
 */
function cleanupRateLimit() {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  for (const [ip, requests] of RATE_LIMIT.entries()) {
    const recentRequests = requests.filter((t) => t > windowStart);
    if (recentRequests.length === 0) {
      RATE_LIMIT.delete(ip);
    } else {
      RATE_LIMIT.set(ip, recentRequests);
    }
  }
}

/**
 * Verify access token using timing-safe comparison
 * @param {string} token - Token from request
 * @param {string} envToken - Token from environment variable
 * @returns {boolean} - true if valid
 */
function verifyToken(token, envToken) {
  if (!envToken) return false;
  if (!token) return false;

  // Use timing-safe comparison to prevent timing attacks
  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(envToken);

  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Fetch traffic information from external API
 * @param {string} trafficUrl - Traffic API endpoint
 * @returns {object|null} - Traffic info object or null
 */
async function fetchTrafficInfo(trafficUrl) {
  if (!trafficUrl) return null;

  try {
    const response = await fetch(trafficUrl, {
      headers: {
        'User-Agent': 'Clash-Verge/1.0',
        Accept: 'application/json',
      },
      cf: {
        // Cache for 30 seconds to avoid hammering the traffic API
        cacheTtl: 30,
        cacheEverything: true,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // JMS format support
    // { monthly_bw_limit_b: total bytes, bw_counter_b: used bytes, bw_reset_day_of_month: reset day }
    if (
      data.monthly_bw_limit_b !== undefined &&
      data.bw_counter_b !== undefined
    ) {
      const total = Number.parseInt(data.monthly_bw_limit_b) || 0;
      const used = Number.parseInt(data.bw_counter_b) || 0;
      const resetDay = Number.parseInt(data.bw_reset_day_of_month) || 1;

      // Calculate next reset date
      const now = new Date();
      const currentDay = now.getDate();
      let resetDate = new Date(
        now.getFullYear(),
        now.getMonth(),
        resetDay,
        0,
        0,
        0
      );

      if (currentDay >= resetDay) {
        resetDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          resetDay,
          0,
          0,
          0
        );
      }

      return {
        upload: 0, // JMS doesn't distinguish upload/download
        download: used, // Count used as download
        total: total,
        expire: Math.floor(resetDate.getTime() / 1000),
      };
    }

    // Generic format support
    if (data.upload !== undefined && data.download !== undefined) {
      return {
        upload: Number.parseInt(data.upload) || 0,
        download: Number.parseInt(data.download) || 0,
        total: Number.parseInt(data.total) || 0,
        expire: data.expire
          ? new Date(data.expire).getTime() / 1000
          : 0,
      };
    }

    return null;
  } catch (e) {
    console.error('[Traffic] Failed to fetch traffic info:', e.message);
    return null;
  }
}

/**
 * Decode Base64 to UTF-8 string (supports Chinese, emoji, etc.)
 * @param {string} base64 - Base64 encoded string
 * @returns {string} - Decoded UTF-8 string
 */
function base64Decode(base64) {
  // Clean the base64 string: remove whitespace, newlines
  const cleaned = base64.replace(/\s/g, '');

  // Convert standard Base64 to URL-safe Base64 if needed
  // Replace URL-safe chars back to standard
  const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if missing
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);

  // Use Uint8Array approach compatible with Cloudflare Workers
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  const len = padded.length;
  const bytes = [];

  for (let i = 0; i < len; i += 4) {
    const encoded1 = lookup[padded.charCodeAt(i)];
    const encoded2 = lookup[padded.charCodeAt(i + 1)];
    const encoded3 = lookup[padded.charCodeAt(i + 2)];
    const encoded4 = lookup[padded.charCodeAt(i + 3)];

    bytes.push((encoded1 << 2) | (encoded2 >> 4));
    if (padded.charAt(i + 2) !== '=') {
      bytes.push(((encoded2 & 15) << 4) | (encoded3 >> 2));
    }
    if (padded.charAt(i + 3) !== '=') {
      bytes.push(((encoded3 & 3) << 6) | encoded4);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Build subscription-userinfo header value
 * @param {object} trafficInfo - Traffic information object
 * @returns {string|null} - Header value string or null if no data
 */
function buildTrafficHeader(trafficInfo) {
  if (!trafficInfo) return null;

  const parts = [];

  // Always include all fields for maximum compatibility
  // All values in bytes, expire in seconds (Unix timestamp)
  parts.push(`upload=${trafficInfo.upload || 0}`);
  parts.push(`download=${trafficInfo.download || 0}`);
  parts.push(`total=${trafficInfo.total || 0}`);
  parts.push(`expire=${trafficInfo.expire || 0}`);

  return parts.join('; ');
}

/**
 * Main entry point
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const userAgent = request.headers.get('User-Agent') || 'unknown';

    // Log access
    console.log(
      `[Access] ${new Date().toISOString()} | ${clientIP} | ${request.method} ${url.pathname} | ${userAgent}`
    );

    // 1. Rate limit check
    if (!checkRateLimit(clientIP)) {
      console.warn(`[RateLimit] IP ${clientIP} exceeded rate limit`);
      return new Response(
        JSON.stringify({ error: 'Too Many Requests', retry_after: 60 }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        }
      );
    }

    // 2. Environment check
    if (!env.ACCESS_TOKEN || !env.YAML_STORAGE) {
      console.error('[Config] Environment variables not configured');
      return new Response(
        JSON.stringify({ error: 'Service Not Configured' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 3. Token authentication
    const token = url.searchParams.get('token');
    if (!verifyToken(token, env.ACCESS_TOKEN)) {
      console.warn(`[Auth] IP ${clientIP} authentication failed`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Only handle subscribe path
    if (url.pathname !== '/subscribe') {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Read YAML from KV and fetch traffic info
    try {
      // Read YAML from KV storage (Base64 encoded)
      const encodedContent = await env.YAML_STORAGE.get('proxy_yaml');

      if (!encodedContent) {
        console.error('[KV] YAML content not found');
        return new Response(
          JSON.stringify({ error: 'YAML not found in KV' }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Decode Base64 content (supports Unicode)
      const yamlContent = base64Decode(encodedContent);

      // Fetch traffic information
      const trafficInfo = await fetchTrafficInfo(env.TRAFFIC_URL); // NOSONAR
      const trafficHeader = buildTrafficHeader(trafficInfo);

      // 6. Build filename from environment variable or use default
      const filename = env.DOWNLOAD_FILENAME || 'JMS';

      // 7. Return response
      const response = new Response(yamlContent, {
        headers: {
          // Use octet-stream for better compatibility with mobile clients
          'Content-Type': 'application/octet-stream; charset=utf-8',
          'Content-Disposition': `attachment; filename=${filename}.yaml`,
          ...(trafficHeader && { 'Subscription-Userinfo': trafficHeader }),
          'profile-update-interval': '24',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });

      console.log(
        `[Success] ${clientIP} | Traffic: ${trafficHeader || 'N/A'}`
      );

      return response;
    } catch (e) {
      console.error(`[Error] ${clientIP} | ${e.message}`);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', message: e.message }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
