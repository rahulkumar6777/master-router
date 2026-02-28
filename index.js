import express from "express";
import httpProxy from "http-proxy";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import dotenv from "dotenv";
import { redisclient, redisConnect } from "./src/configs/redis.js";
import http from "http";

dotenv.config();
await redisConnect();

const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({});

app.set("trust proxy", true);

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],

      // APIs, WebSockets, etc.
      connectSrc: ["'self'", "https://api.razorpay.com", "*"],

      // Images (local, data URIs, external CDNs)
      imgSrc: ["'self'", "data:", "https:", "*"],

      // Media (audio/video)
      mediaSrc: ["'self'", "data:", "https:"],

      // Scripts (local, inline if needed, external CDNs)
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // only if you really need inline scripts
        "'unsafe-eval'", // only if you use eval-like constructs
        "https:",
      ],

      // Styles (local, inline, external CDNs like Google Fonts)
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // needed for inline styles
        "https:",
      ],

      // Fonts (Google Fonts, etc.)
      fontSrc: ["'self'", "https:", "data:"],

      // Frames (payment gateways, embeds)
      frameSrc: [
        "'self'",
        "https://api.razorpay.com",
        "https://*.razorpay.com",
        "https://www.youtube.com",
        "https://player.vimeo.com",
      ],

      // Form submissions
      formAction: ["'self'", "https://api.razorpay.com"],

      // Prevent plugins/Flash
      objectSrc: ["'none'"],

      // Restrict <base> tag
      baseUri: ["'self'"],

      // Optional: block mixed content
      upgradeInsecureRequests: [],
    },
  }),
);

app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 300 }));

function setCorsHeaders(res, origin, requestHeaders) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestHeaders ||
      "Content-Type, Authorization, X-Requested-With, Accept, Origin",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, X-Kuma-Revision",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Helper function for subdomain extraction
function getSubdomain(domain, root) {
  if (!domain.endsWith(root)) return null;
  const withoutRoot = domain.slice(0, -(root.length + 1)); // remove ".root"
  return withoutRoot || null;
}

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(
      res,
      req.headers.origin,
      req.headers["access-control-request-headers"],
    );
    return res.status(204).end();
  }
  next();
});

app.use((req, res, next) => {
  setCorsHeaders(
    res,
    req.headers.origin,
    req.headers["access-control-request-headers"],
  );
  next();
});

proxy.on("proxyRes", (proxyRes, req) => {
  const origin = req.headers.origin;
  proxyRes.headers["access-control-allow-origin"] = origin || "*";
  proxyRes.headers["vary"] = "Origin";
  proxyRes.headers["access-control-allow-credentials"] = "true";
  proxyRes.headers["access-control-allow-methods"] =
    "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";
  proxyRes.headers["access-control-allow-headers"] =
    req.headers["access-control-request-headers"] ||
    "Content-Type, Authorization, X-Requested-With, Accept, Origin";
  proxyRes.headers["access-control-expose-headers"] =
    "Content-Length, X-Kuma-Revision";
});

proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Service unavailable");
  }
});

app.use(async (req, res) => {
  try {
    const domain = req.headers.host?.toLowerCase();
    if (!domain) return res.status(400).send("Invalid Host");

    // Static mappings
    if (["deployhub.cloud", "www.deployhub.cloud"].includes(domain)) {
      return proxy.web(req, res, { target: "http://deployhub:80" });
    }
    if (["cloudcoderhub.in", "www.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://cloucoderhub:80" });
    }
    if (["console.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://minio:9000" });
    }
    if (["storage.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://minio:9001" });
    }
    if (["devload.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://devload:80" });
    }
    if (["app-devload.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://appdevload:80" });
    }
    if (["api-devload.cloudcoderhub.in"].includes(domain)) {
      return proxy.web(req, res, { target: "http://apidevload:6700" });
    }
    if (["dashboard.deployhub.cloud"].includes(domain)) {
      return proxy.web(req, res, { target: "http://appdeployhub:80" });
    }
    if (["api.deployhub.cloud"].includes(domain)) {
      return proxy.web(req, res, { target: "http://apideployhub:5000" });
    }

    // Redis lookup for custom domains
    const custom = await redisclient.hgetall(`domain:${domain}`);
    if (custom && custom.port) {
      const target = `http://${custom.service}:${custom.port}`;
      return proxy.web(req, res, { target });
    }

    // Only subdomains of deployhub.online
    const subdomain = getSubdomain(domain, "deployhub.online");
    console.log(subdomain);
    if (subdomain) {
      const project = await redisclient.hgetall(`subdomain:${subdomain}`);
      if (project && project.port) {
        const target = `http://${project.service}:${project.port}`;
        return proxy.web(req, res, { target });
      } else {
        return res.status(404).send("Domain not configured");
      }
    }

    return res.status(404).send(`
      <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Site not found — NestHost</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800;900&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: #050810;
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      overflow: hidden;
      position: relative;
    }

    /* Background glow */
    body::before {
      content: '';
      position: fixed;
      top: -100px;
      left: 50%;
      transform: translateX(-50%);
      width: 600px;
      height: 500px;
      background: radial-gradient(ellipse, rgba(0,229,255,0.06) 0%, transparent 70%);
      pointer-events: none;
    }

    /* Dot grid */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, rgba(255,255,255,0.025) 1px, transparent 1px);
      background-size: 28px 28px;
      pointer-events: none;
    }

    /* Card */
    .card {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 420px;
      background: rgba(13,17,23,0.95);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 20px;
      overflow: hidden;
      text-align: center;
      animation: fadeUp 0.5s ease both;
      height: 500px;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Top accent line */
    .card::before {
      content: '';
      display: block;
      height: 1px;
      background: linear-gradient(90deg, transparent, #00e5ff 50%, transparent);
    }

    .card-inner {
      padding: 2.5rem 2rem 2rem;
    }

    /* 404 badge */
    .badge-404 {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: 'Syne', sans-serif;
      font-weight: 900;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #00e5ff;
      background: rgba(0,229,255,0.08);
      border: 1px solid rgba(0,229,255,0.15);
      border-radius: 999px;
      padding: 5px 14px;
      margin-bottom: 1.25rem;
      height: 30px;
    }

    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #00e5ff;
      animation: pulse 2s ease infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    h1 {
      font-family: 'Syne', sans-serif;
      font-weight: 900;
      font-size: 1.6rem;
      color: #fff;
      margin-bottom: 0.75rem;
      line-height: 1.2;
    }

    .subtitle {
      font-size: 0.875rem;
      color: #4b5563;
      line-height: 1.6;
      margin-bottom: 1.75rem;
    }

    .domain-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 1.75rem;
      text-align: left;
    }

    .domain-icon {
      color: #374151;
      flex-shrink: 0;
    }

    .domain-url {
      font-size: 12px;
      color: #374151;
      word-break: break-all;
    }
  </style>
</head>
<body>

  <!-- Card -->
  <div class="card">
    <div class="card-inner">

      <div class="badge-404">
        <span class="badge-dot"></span>
        404 · Not Found
      </div>

      <h1>Site not configured</h1>

      <p class="subtitle">
        This domain isn't connected to any project yet,<br>
        or the deployment is no longer active.
      </p>

      <!-- Current URL -->
      <div class="domain-box">
        <svg class="domain-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <span class="domain-url" id="current-url">—</span>
      </div>

    </div>
  </div>

  <script>
    // Show current URL in the box
    document.getElementById('current-url').textContent = window.location.href
  </script>

</body>
</html>
      `);
  } catch {
    return res.status(500).send("Internal server error");
  }
});

server.on("upgrade", async (req, socket, head) => {
  try {
    const domain = req.headers.host?.toLowerCase();
    if (!domain) return socket.destroy();

    let target;

    if (["deployhub.cloud", "www.deployhub.cloud"].includes(domain)) {
      target = "http://deployhub:80";
    } else if (["cloudcoderhub.in", "www.cloudcoderhub.in"].includes(domain)) {
      target = "http://cloucoderhub:80";
    } else if (["console.cloudcoderhub.in"].includes(domain)) {
      target = "http://minio:9000";
    } else if (["storage.cloudcoderhub.in"].includes(domain)) {
      target = "http://minio:9001";
    } else if (["app.deployhub.cloud"].includes(domain)) {
      target = "http://appdeployhub:80";
    } else if (["api-devload.cloudcoderhub.in"].includes(domain)) {
      target = "http://apidevload:6700";
    } else {
      const custom = await redisclient.hgetall(`domain:${domain}`);
      if (custom && custom.port) {
        target = `http://${custom.service}:${custom.port}`;
      } else {
        const subdomain = getSubdomain(domain, "deployhub.online");
        if (subdomain) {
          const project = await redisclient.hgetall(`subdomain:${subdomain}`);
          if (project && project.port) {
            target = `http://${project.service}:${project.port}`;
          }
        }
      }
    }

    if (target) {
      proxy.ws(req, socket, head, { target });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

server.listen(8080, () => {
  console.log("Router running on port 8080 with WebSocket support");
});
