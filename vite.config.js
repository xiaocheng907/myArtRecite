import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function githubPagesBase() {
  const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (!process.env.GITHUB_ACTIONS || !repoName || repoName.endsWith(".github.io")) return "/";
  return `/${repoName}/`;
}

function permanentSavePlugin() {
  return {
    name: "art-recite-permanent-save",
    configureServer(server) {
      server.middlewares.use("/api/save-content", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }

        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 15 * 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (!Array.isArray(payload.chapters) || !payload.settings) {
              throw new Error("Invalid save payload");
            }
            const target = path.resolve(server.config.root, "public", "saved-content.json");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, JSON.stringify({
              ...payload,
              savedAt: new Date().toISOString(),
            }, null, 2), "utf8");
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: githubPagesBase(),
  plugins: [react(), permanentSavePlugin()],
});
