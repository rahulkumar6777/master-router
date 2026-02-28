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
const proxy = httpProxy.createProxyServer({
  // proxy options – kuch extra nahi
});

app.set("trust proxy", true);

// Security headers (CORS-related nahi hain, isliye safe hain)
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    connectSrc: ["'self'", "https://api.razorpay.com", "*"],
    imgSrc: ["'self'", "data:", "https:", "*"],
    mediaSrc: ["'self'", "data:", "https:"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"],
    styleSrc: ["'self'", "'unsafe-inline'", "https:"],
    fontSrc: ["'self'", "https:", "data:"],
    frameSrc: ["'self'", "https://api.razorpay.com", "https://*.razorpay.com", "https://www.youtube.com", "https://player.vimeo.com"],
    formAction: ["'self'", "https://api.razorpay.com"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    upgradeInsecureRequests: [],
  },
}));

app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 300 }));

// Helper function for subdomain extraction
function getSubdomain(domain, root) {
  if (!domain.endsWith(root)) return null;
  const withoutRoot = domain.slice(0, -(root.length + 1));
  return withoutRoot || null;
}

// Proxy error handling
proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Service unavailable");
  }
});

// Main request handler – sirf proxy karega, CORS headers nahi lega
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

    // Subdomains of deployhub.online
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

    // Agar koi mapping na mile to 404 page
    return res.status(404).send(`
      <!DOCTYPE html>
      ... (aapka existing 404 HTML yahan rahega) ...
    `);
  } catch {
    return res.status(500).send("Internal server error");
  }
});

// WebSocket upgrade handling – same as before, no CORS changes needed
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
  console.log("Router running on port 8080 with WebSocket support – pure pass‑through mode");
});