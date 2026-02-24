import express from "express";
import httpProxy from "http-proxy";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import dotenv from "dotenv";
import { redisclient, redisConnect } from "./src/configs/redis.js";

dotenv.config();
await redisConnect();

const app = express();
const proxy = httpProxy.createProxyServer({});


app.use(helmet());
app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 300 }));


proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) {
    res.status(502).send("Service unavailable");
  }
});

app.use(async (req, res) => {
  try {
    const domain = req.headers.host?.toLowerCase();
    if (!domain) return res.status(400).send("Invalid Host");

    
    const PLATFORM = ["deployhub.cloud", "www.deployhub.cloud"];

    if (PLATFORM.includes(domain)) {
      return proxy.web(req, res, {
        target: "http://deployhub:4000"
      });
    }

    
    const PLATFORMSUBDOMAIN = ["app.deployhub.cloud"];

    if (PLATFORMSUBDOMAIN.includes(domain)) {
      return proxy.web(req, res, {
        target: "http://appdeployhub:4000"
      });
    }

    
    const custom = await redisclient.hgetall(`domain:${domain}`);

    if (custom && custom.port) {
      const target = `http://${custom.service}:${custom.port}`;
      return proxy.web(req, res, { target });
    }

    
    if (domain.endsWith(".deployhub.in")) {
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

app.listen(8080, () => {
  console.log("Router running on port 8080");
});