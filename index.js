import express from "express";
import http from "http";
import httpProxy from "http-proxy";
import compression from "compression";
import dotenv from "dotenv";
import { redisclient, redisConnect } from "./src/configs/redis.js";

dotenv.config();
await redisConnect();

const app = express();
const server = http.createServer(app);

app.set("trust proxy", true);
app.use(compression());

//  HTTP proxy with agent
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,
});

const httpProxyServer = httpProxy.createProxyServer({
  changeOrigin: true,
  xfwd: true,
  agent: httpAgent,
});

//  WS proxy without agent
const wsProxyServer = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  xfwd: true,
});

// --- domain resolution helpers (same as before) ---
const domainCache = new Map();
const CACHE_TTL = 30_000;

function setCache(key, value) {
  domainCache.set(key, { value, expires: Date.now() + CACHE_TTL });
}
function getCache(key) {
  const entry = domainCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    domainCache.delete(key);
    return null;
  }
  return entry.value;
}

const staticMap = {
  "deployhub.cloud": "http://deployhub:80",
  "www.deployhub.cloud": "http://deployhub:80",
  "cloudcoderhub.in": "http://cloucoderhub:80",
  "www.cloudcoderhub.in": "http://cloucoderhub:80",
  "console.cloudcoderhub.in": "http://minio:9000",
  "storage.cloudcoderhub.in": "http://minio:9001",
  "devload.cloudcoderhub.in": "http://devload:80",
  "app-devload.cloudcoderhub.in": "http://appdevload:80",
  "api-devload.cloudcoderhub.in": "http://apidevload:6700",
  "dashboard.deployhub.cloud": "http://appdeployhub:80",
  "api.deployhub.cloud": "http://apideployhub:5000",
};

function getSubdomain(domain, root) {
  if (!domain.endsWith(root)) return null;
  const withoutRoot = domain.slice(0, -(root.length + 1));
  return withoutRoot || null;
}

async function resolveDomain(domain) {
  const cached = getCache(domain);
  if (cached) return cached;

  if (staticMap[domain]) {
    setCache(domain, staticMap[domain]);
    return staticMap[domain];
  }

  const custom = await redisclient.hgetall(`domain:${domain}`);
  if (custom?.port) {
    const target = `http://${custom.service}:${custom.port}`;
    setCache(domain, target);
    return target;
  }

  const subdomain = getSubdomain(domain, "deployhub.online");
  if (subdomain) {
    const project = await redisclient.hgetall(`subdomain:${subdomain}`);
    if (project?.port) {
      const target = `http://${project.service}:${project.port}`;
      setCache(domain, target);
      return target;
    }
  }

  return null;
}

// --- HTTP routing ---
app.use(async (req, res) => {
  try {
    const host = req.headers.host?.toLowerCase();
    if (!host) return res.status(400).send("Invalid host");

    const target = await resolveDomain(host);
    if (!target) return res.status(404).send("Domain not configured");

    httpProxyServer.web(req, res, { target });
  } catch (err) {
    console.error("Router error:", err);
    res.status(500).send("Internal server error");
  }
});

// --- WebSocket upgrade routing ---
server.on("upgrade", async (req, socket, head) => {
  try {
    console.log("Upgrade request:", req.url, req.headers);

    const host = req.headers.host?.toLowerCase();
    if (!host) return socket.destroy();

    const target = await resolveDomain(host);
    if (!target) return socket.destroy();

    wsProxyServer.ws(req, socket, head, { target, changeOrigin: false });
  } catch (err) {
    console.error("WS Error:", err);
    socket.destroy();
  }
});

// --- Error handling ---
httpProxyServer.on("error", (err, req, res) => {
  console.error("HTTP Proxy error:", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Service unavailable");
  }
});

wsProxyServer.on("error", (err, req, socket) => {
  console.error("WS Proxy error:", err.message);
  if (socket) socket.destroy();
});

server.listen(8080, () => {
  console.log("Production Router running on port 8080");
});