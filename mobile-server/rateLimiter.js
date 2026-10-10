/**
 * Lightweight in-memory sliding window rate limiter for Express
 * Accurately tracks request timestamps per client IP / key
 */
class SlidingWindowRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, max = 100, message = "Too many requests, please try again later.", keyGenerator }) {
    this.windowMs = windowMs;
    this.max = max;
    this.message = message;
    this.keyGenerator = keyGenerator || ((req) => req.ip || req.connection.remoteAddress || "unknown");
    this.hits = new Map();

    // Auto-clean expired entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.hits.entries()) {
      const valid = timestamps.filter(t => now - t < this.windowMs);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }

  reset(key) {
    if (key) {
      this.hits.delete(key);
    } else {
      this.hits.clear();
    }
  }

  middleware() {
    return (req, res, next) => {
      const key = this.keyGenerator(req);
      const now = Date.now();

      let timestamps = this.hits.get(key) || [];
      timestamps = timestamps.filter(t => now - t < this.windowMs);

      if (timestamps.length >= this.max) {
        const oldest = timestamps[0];
        const resetTimeMs = (oldest + this.windowMs) - now;
        const retryAfterSeconds = Math.ceil(resetTimeMs / 1000);

        res.setHeader("Retry-After", retryAfterSeconds);
        res.setHeader("X-RateLimit-Limit", this.max);
        res.setHeader("X-RateLimit-Remaining", 0);
        res.setHeader("X-RateLimit-Reset", Math.ceil((oldest + this.windowMs) / 1000));

        return res.status(429).json({
          success: false,
          error: this.message,
          retryAfter: retryAfterSeconds
        });
      }

      timestamps.push(now);
      this.hits.set(key, timestamps);

      res.setHeader("X-RateLimit-Limit", this.max);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, this.max - timestamps.length));

      next();
    };
  }
}

// 1. Strict Limiter for Login (10 attempts / 15 mins per IP)
const loginLimiter = new SlidingWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many authentication attempts. Please try again after 15 minutes."
});

// 2. Strict Limiter for Registration (5 attempts / 15 mins per IP)
const registerLimiter = new SlidingWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many registration attempts. Please try again after 15 minutes."
});

// 3. Strict Limiter for WhatsApp Pairing Code Requests (5 requests / 15 mins)
const pairingLimiter = new SlidingWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many pairing code requests. Please wait 15 minutes before requesting another code.",
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}` : req.ip)
});

// 4. Contact Import Limiter (20 imports / min)
const contactImportLimiter = new SlidingWindowRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many contact sync requests. Please slow down.",
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}` : req.ip)
});

// 5. General API Limiter (300 requests / 15 mins)
const generalApiLimiter = new SlidingWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: "API rate limit exceeded. Please try again later."
});

module.exports = {
  SlidingWindowRateLimiter,
  loginLimiterInstance: loginLimiter,
  registerLimiterInstance: registerLimiter,
  pairingLimiterInstance: pairingLimiter,
  contactImportLimiterInstance: contactImportLimiter,
  generalApiLimiterInstance: generalApiLimiter,
  loginLimiter: loginLimiter.middleware(),
  registerLimiter: registerLimiter.middleware(),
  pairingLimiter: pairingLimiter.middleware(),
  contactImportLimiter: contactImportLimiter.middleware(),
  generalApiLimiter: generalApiLimiter.middleware()
};
