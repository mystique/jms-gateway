/**
 * JMS Gateway - Cloudflare Workers (KV Storage Edition)
 * YAML config stored in Cloudflare KV, no external hosting needed
 * Features: Token authentication, rate limiting, traffic info injection
 */

/**
 * Unified Sliding Window Rate Limiter
 * Uses improved sliding window with dual counters for better accuracy
 * Includes automatic cleanup to prevent memory leaks
 */
class RateLimiter {
  /**
   * @param {number} windowMs - Window size in milliseconds
   * @param {number} maxRequests - Max requests per window
   */
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.records = new Map();
    this.lastCleanup = Date.now();
    this.cleanupInterval = 5 * 60 * 1000; // Clean up every 5 minutes
  }

  /**
   * Clean up expired records to prevent memory leaks
   */
  _cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) return;

    this.lastCleanup = now;
    let deleted = 0;

    for (const [key, record] of this.records) {
      // Check if record is completely expired and can be removed
      const isExpired = record.bannedUntil
        ? now >= record.bannedUntil && now - record.windowStart >= this.windowMs
        : now - record.windowStart >= this.windowMs * 2;

      if (isExpired) {
        this.records.delete(key);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[RateLimiter] Cleaned up ${deleted} expired records`);
    }
  }

  /**
   * Calculate weighted count using sliding window with dual counters
   * @param {object} record - The rate limit record
   * @param {number} now - Current timestamp
   * @returns {number} - Weighted request count
   */
  _getWeightedCount(record, now) {
    const elapsed = now - record.windowStart;

    // If within current window, use full count
    if (elapsed < this.windowMs) {
      // Calculate weighted count: previous window * (1 - elapsed/window) + current window
      const prevWeight = Math.max(0, 1 - elapsed / this.windowMs);
      return Math.floor(record.prevCount * prevWeight + record.currCount);
    }

    // Window has expired, reset counters
    return 0;
  }

  /**
   * Check and increment rate limit
   * @param {string} key - Key to rate limit (e.g., IP address)
   * @returns {boolean} - true if allowed, false if rate limited
   */
  checkAndIncrement(key) {
    this._cleanup();

    const now = Date.now();
    let record = this.records.get(key);

    // No existing record - create new one
    if (!record) {
      this.records.set(key, {
        prevCount: 0,
        currCount: 1,
        windowStart: now,
        bannedUntil: null,
      });
      return true;
    }

    // Check if currently banned
    if (record.bannedUntil && now < record.bannedUntil) {
      return false;
    }

    // Clear ban if expired
    if (record.bannedUntil && now >= record.bannedUntil) {
      record.bannedUntil = null;
    }

    const elapsed = now - record.windowStart;

    // If window has expired, slide it
    if (elapsed >= this.windowMs) {
      // Calculate how many full windows have passed
      const windowsToSlide = Math.floor(elapsed / this.windowMs);

      if (windowsToSlide === 1) {
        // One window passed: current becomes previous, reset current
        record.prevCount = record.currCount;
        record.currCount = 0;
      } else {
        // Multiple windows passed: both counters reset
        record.prevCount = 0;
        record.currCount = 0;
      }

      record.windowStart += windowsToSlide * this.windowMs;
    }

    // Check if under limit
    const weightedCount = this._getWeightedCount(record, now);
    if (weightedCount >= this.maxRequests) {
      return false;
    }

    // Increment counter
    record.currCount++;
    this.records.set(key, record);
    return true;
  }

  /**
   * Get current record for a key
   * @param {string} key - Key to look up
   * @returns {object|null} - Record or null
   */
  getRecord(key) {
    return this.records.get(key) || null;
  }

  /**
   * Set a ban on a key
   * @param {string} key - Key to ban
   * @param {number} durationMs - Ban duration in milliseconds
   */
  ban(key, durationMs) {
    const now = Date.now();
    let record = this.records.get(key);

    if (!record) {
      record = {
        prevCount: 0,
        currCount: 0,
        windowStart: now,
        bannedUntil: null,
      };
    }

    record.bannedUntil = now + durationMs;
    this.records.set(key, record);
  }

  /**
   * Check if key is banned
   * @param {string} key - Key to check
   * @returns {boolean} - true if banned
   */
  isBanned(key) {
    const record = this.records.get(key);
    if (!record) return false;
    if (!record.bannedUntil) return false;
    return Date.now() < record.bannedUntil;
  }

  /**
   * Clear record for a key
   * @param {string} key - Key to clear
   */
  clear(key) {
    this.records.delete(key);
  }
}

// Rate limiting: max 30 requests per IP per minute (improved sliding window)
const RATE_LIMITER = new RateLimiter(60000, 30);

// Auth failure limiting: max 5 failures per IP per 15 minutes, ban for 30 minutes
const AUTH_FAIL_LIMITER = new RateLimiter(15 * 60 * 1000, 5);
const AUTH_FAIL_BAN_DURATION = 30 * 60 * 1000; // 30 minutes ban

/**
 * Check rate limit for an IP address
 * @param {string} ip - Client IP address
 * @returns {boolean} - true if allowed, false if rate limited
 */
function checkRateLimit(ip) {
  return RATE_LIMITER.checkAndIncrement(ip);
}

/**
 * Check if IP is banned due to too many auth failures
 * @param {string} ip - Client IP address
 * @returns {boolean} - true if allowed, false if banned
 */
function checkAuthFailLimit(ip) {
  return !AUTH_FAIL_LIMITER.isBanned(ip);
}

/**
 * Record an authentication failure for an IP
 * @param {string} ip - Client IP address
 */
function recordAuthFail(ip) {
  const now = Date.now();

  // Check and increment auth failure count
  const allowed = AUTH_FAIL_LIMITER.checkAndIncrement(ip);

  // If not allowed, it means we've hit the limit - set ban
  if (!allowed) {
    // Check if already banned to avoid duplicate warnings
    const record = AUTH_FAIL_LIMITER.getRecord(ip);
    if (!record || !record.bannedUntil || now >= record.bannedUntil) {
      AUTH_FAIL_LIMITER.ban(ip, AUTH_FAIL_BAN_DURATION);
      console.warn(
        `[AuthBan] IP ${ip} banned for ${AUTH_FAIL_BAN_DURATION / 60000} minutes due to too many auth failures`,
      );
    }
  }
}

/**
 * Clear auth failure records (called on successful auth)
 * @param {string} ip - Client IP address
 */
function clearAuthFail(ip) {
  AUTH_FAIL_LIMITER.clear(ip);
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
        "User-Agent": "Clash-Verge/1.0",
        Accept: "application/json",
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
        0,
      );

      if (currentDay >= resetDay) {
        resetDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          resetDay,
          0,
          0,
          0,
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
        expire: data.expire ? new Date(data.expire).getTime() / 1000 : 0,
      };
    }

    return null;
  } catch (e) {
    console.error("[Traffic] Failed to fetch traffic info:", e.message);
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
  const cleaned = base64.replace(/\s/g, "");

  // Convert standard Base64 to URL-safe Base64 if needed
  // Replace URL-safe chars back to standard
  const normalized = cleaned.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if missing
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);

  // Use Uint8Array approach compatible with Cloudflare Workers
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
    if (padded.charAt(i + 2) !== "=") {
      bytes.push(((encoded2 & 15) << 4) | (encoded3 >> 2));
    }
    if (padded.charAt(i + 3) !== "=") {
      bytes.push(((encoded3 & 3) << 6) | encoded4);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Convert bytes from 1000-based to 1024-based representation,
 * so that client software dividing by 1024^3 displays the correct 1000-based GB value.
 * e.g., 500 GB (1000-based) → client shows "500G" instead of "465.66G"
 * @param {number} bytes - Byte value in 1000-based units
 * @returns {number} - Adjusted value for 1024-based display
 */
function convertTo1024Display(bytes) {
  return Math.round(bytes * Math.pow(1024 / 1000, 3));
}

/**
 * Build subscription-userinfo header value
 * @param {object} trafficInfo - Traffic information object
 * @returns {string|null} - Header value string or null if no data
 */
function buildTrafficHeader(trafficInfo) {
  if (!trafficInfo) return null;

  const parts = [];

  // Convert from 1000-based bytes to 1024-based representation so clients
  // display the correct decimal GB/TB value instead of a smaller binary GiB value.
  // expire is a Unix timestamp (seconds), not bytes — no conversion needed.
  parts.push(`upload=${convertTo1024Display(trafficInfo.upload || 0)}`);
  parts.push(`download=${convertTo1024Display(trafficInfo.download || 0)}`);
  parts.push(`total=${convertTo1024Display(trafficInfo.total || 0)}`);
  parts.push(`expire=${trafficInfo.expire || 0}`);

  return parts.join("; ");
}

/**
 * Main entry point
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const userAgent = request.headers.get("User-Agent") || "unknown";

    // Log access
    console.log(
      `[Access] ${new Date().toISOString()} | ${clientIP} | ${request.method} ${url.pathname} | ${userAgent}`,
    );

    // 1. Rate limit check
    if (!checkRateLimit(clientIP)) {
      console.warn(`[RateLimit] IP ${clientIP} exceeded rate limit`);
      return new Response(
        JSON.stringify({ error: "Too Many Requests", retry_after: 60 }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "60",
          },
        },
      );
    }

    // 2. Auth failure limit check
    if (!checkAuthFailLimit(clientIP)) {
      console.warn(
        `[AuthLimit] IP ${clientIP} is banned due to too many auth failures`,
      );
      return new Response(
        JSON.stringify({
          error: "Too Many Authentication Failures",
          retry_after: 1800,
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "1800",
          },
        },
      );
    }

    // 3. Environment check
    if (!env.ACCESS_TOKEN || !env.YAML_STORAGE) {
      console.error("[Config] Environment variables not configured");
      return new Response(JSON.stringify({ error: "Service Not Configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Token authentication
    const token = url.searchParams.get("token");
    if (!verifyToken(token, env.ACCESS_TOKEN)) {
      console.warn(`[Auth] IP ${clientIP} authentication failed`);
      recordAuthFail(clientIP);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Clear auth failures on successful authentication
    clearAuthFail(clientIP);

    // 4. Only handle subscribe path
    if (url.pathname !== "/subscribe") {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Read YAML from KV and fetch traffic info
    try {
      // Read YAML from KV storage (Base64 encoded)
      const encodedContent = await env.YAML_STORAGE.get("proxy_yaml");

      if (!encodedContent) {
        console.error("[KV] YAML content not found");
        return new Response(JSON.stringify({ error: "YAML not found in KV" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Decode Base64 content (supports Unicode)
      const yamlContent = base64Decode(encodedContent);

      // Fetch traffic information
      const trafficInfo = await fetchTrafficInfo(env.TRAFFIC_URL); // NOSONAR
      const trafficHeader = buildTrafficHeader(trafficInfo);

      // 6. Build filename from environment variable or use default
      const filename = env.DOWNLOAD_FILENAME || "JMS";

      // 7. Return response
      const response = new Response(yamlContent, {
        headers: {
          // Use octet-stream for better compatibility with mobile clients
          "Content-Type": "application/octet-stream; charset=utf-8",
          "Content-Disposition": `attachment; filename=${filename}.yaml`,
          ...(trafficHeader && { "Subscription-Userinfo": trafficHeader }),
          "profile-update-interval": "24",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });

      console.log(`[Success] ${clientIP} | Traffic: ${trafficHeader || "N/A"}`);

      return response;
    } catch (e) {
      console.error(`[Error] ${clientIP} | ${e.message}`);
      return new Response(
        JSON.stringify({ error: "Internal Server Error", message: e.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
