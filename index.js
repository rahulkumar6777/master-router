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


const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,
});


const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  xfwd: true,
  //agent,
});


const domainCache = new Map();
const CACHE_TTL = 30_000;

function setCache(key, value) {
  domainCache.set(key, {
    value,
    expires: Date.now() + CACHE_TTL,
  });
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

  // Static domains
  if (staticMap[domain]) {
    setCache(domain, staticMap[domain]);
    return staticMap[domain];
  }

  // Custom domains
  const custom = await redisclient.hgetall(`domain:${domain}`);
  if (custom?.port) {
    const target = `http://${custom.service}:${custom.port}`;
    setCache(domain, target);
    return target;
  }

  // Subdomains
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


app.use(async (req, res) => {
  try {
    const host = req.headers.host?.toLowerCase();
    if (!host) return res.status(400).send("Invalid host");

    const target = await resolveDomain(host);
    if (!target) return res.status(404).send("Domain not configured");

    proxy.web(req, res, { target });
  } catch (err) {
    console.error("Router error:", err);
    res.status(500).send("Internal server error");
  }
});


proxy.on("proxyReqWs", (proxyReq, req) => {
  proxyReq.setHeader("X-Forwarded-Proto", req.headers["x-forwarded-proto"] || "https");
  proxyReq.setHeader("X-Forwarded-Host", req.headers.host);
  proxyReq.setHeader("Origin", `https://${req.headers.host}`);
});

server.on("upgrade", async (req, socket, head) => {
  try {
    console.log("WS upgrade request for:", req.headers.host, req.url);
    const host = req.headers.host?.toLowerCase();
    if (!host) return socket.destroy();

    const target = await resolveDomain(host);
    console.log(target)
    if (!target) return socket.destroy();

    proxy.ws(req, socket, head, { 
      target,
      changeOrigin: true,
      ws: true,
      secure: false,
    });
  } catch(err) {
    console.error("ws Error" , err)
    socket.destroy();
  }
});


proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);

  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Service unavailable");
  }
});

server.listen(8080, () => {
  console.log("Production Router running on port 8080");
});