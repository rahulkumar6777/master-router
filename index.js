import express from "express";
import httpProxy from "http-proxy";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import dotenv from "dotenv";
import { redisclient, redisConnect } from "./src/configs/redis.js";
import http from "http";
import cors from "cors";

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
      imgSrc: ["'self'", "data:", "*"]
    },
  }),
);
app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 300 }));
app.use(cors("*"));

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Service unavailable");
  }
});

// Normal HTTP routing
app.use(async (req, res) => {
  try {
    const domain = req.headers.host?.toLowerCase();
    if (!domain) return res.status(400).send("Invalid Host");

    const PLATFORM = ["deployhub.cloud", "www.deployhub.cloud"];
    if (PLATFORM.includes(domain)) {
      return proxy.web(req, res, { target: "http://deployhub:80" });
    }

    const PLATFORM2 = ["cloudcoderhub.in", "www.cloudcoderhub.in"];
    if (PLATFORM2.includes(domain)) {
      return proxy.web(req, res, { target: "http://cloucoderhub:80" });
    }

    const PLATFORM3 = ["console.cloudcoderhub.in"];
    if (PLATFORM3.includes(domain)) {
      return proxy.web(req, res, { target: "http://minio:9000" });
    }

    const PLATFORM4 = ["storage.cloudcoderhub.in"];
    if (PLATFORM4.includes(domain)) {
      return proxy.web(req, res, { target: "http://minio:9001" });
    }
    const PLATFORM5 = ["devload.cloudcoderhub.in"];
    if (PLATFORM5.includes(domain)) {
      return proxy.web(req, res, { target: "http://devload:80" });
    }
    const PLATFORM6 = ["app-devload.cloudcoderhub.in"];
    if (PLATFORM6.includes(domain)) {
      return proxy.web(req, res, { target: "http://appdevload:80" });
    }
    const PLATFORM7 = ["api-devload.cloudcoderhub.in"];
    if (PLATFORM7.includes(domain)) {
      return proxy.web(req, res, { target: "http://apidevload:6700" });
    }

    const PLATFORMSUBDOMAIN = ["app.deployhub.cloud"];
    if (PLATFORMSUBDOMAIN.includes(domain)) {
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
  } catch (err) {
    console.error("Routing error:", err);
    return res.status(500).send("Internal server error");
  }
});

// Handle WebSocket upgrade events
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
  } catch (err) {
    console.error("WebSocket routing error:", err);
    socket.destroy();
  }
});

server.listen(8080, () => {
  console.log("Router running on port 8080 with WebSocket support");
});
