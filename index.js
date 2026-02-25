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
      connectSrc: ["'self'", "*"],
      imgSrc: ["'self'", "data:", "*"],
      mediaSrc: ["'self'", "data:", "*"],
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

    if (["app.deployhub.cloud"].includes(domain)) {
      return proxy.web(req, res, { target: "http://appdeployhub:80" });
    }

    const custom = await redisclient.hgetall(`domain:${domain}`);
    if (custom && custom.port) {
      const target = `http://${custom.service}:${custom.port}`;
      return proxy.web(req, res, { target });
    }

    if (domain.endsWith(".deployhub.online")) {
      const subdomain = domain.split(".")[0];
      const project = await redisclient.hgetall(`subdomain:${subdomain}`);
      if (project && project.port) {
        const target = `http://${project.service}:${project.port}`;
        return proxy.web(req, res, { target });
      }
    }

    return res.status(404).send("Domain not configured");
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
      } else if (domain.endsWith(".deployhub.online")) {
        const subdomain = domain.split(".")[0];
        const project = await redisclient.hgetall(`subdomain:${subdomain}`);
        if (project && project.port) {
          target = `http://${project.service}:${project.port}`;
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
