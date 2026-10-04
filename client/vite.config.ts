import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const visualAssets = [
  ["../docs/assets/herdr-mise-tui-demo.gif", "tui-demo.gif"],
  ["../docs/assets/herdr-mise-tui-demo.mp4", "tui-demo.mp4"],
  ["../docs/assets/herdr-mise-tui-demo.webm", "tui-demo.webm"],
  ["../docs/assets/herdr-mise-tui-demo.vtt", "tui-demo.vtt"],
  ["../docs/assets/herdr-mise-tui-demo-poster.png", "tui-demo-poster.png"],
  ["../docs/assets/herdr-mise-demo-poster.png", "og.png"],
] as const;

const contentTypes: Record<string, string> = {
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  vtt: "text/vtt; charset=utf-8",
  png: "image/png",
};

function visualSite(): Plugin {
  return {
    name: "visual-site",
    // Fix npm run dev:visual assets
    configureServer(server) {
      for (const [path, fileName] of visualAssets) {
        const asset = fileURLToPath(new URL(path, import.meta.url));
        if (!existsSync(asset)) continue;
        server.middlewares.use(`/${fileName}`, (request, response) => {
          const body = readFileSync(asset);
          response.setHeader(
            "Content-Type",
            contentTypes[fileName.split(".").pop()!] ?? "image/png",
          );
          response.setHeader("Accept-Ranges", "bytes");
          // Video elements seek (and Safari plays) only with byte ranges.
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
          if (!range || (!range[1] && !range[2])) {
            response.end(body);
            return;
          }
          const start = range[1]
              ? Number(range[1])
              : Math.max(0, body.length - Number(range[2])),
            end =
              range[1] && range[2]
                ? Math.min(Number(range[2]), body.length - 1)
                : body.length - 1;
          if (start > end || start >= body.length) {
            response.statusCode = 416;
            response.setHeader("Content-Range", `bytes */${body.length}`);
            response.end();
            return;
          }
          response.statusCode = 206;
          response.setHeader(
            "Content-Range",
            `bytes ${start}-${end}/${body.length}`,
          );
          response.end(body.subarray(start, end + 1));
        });
      }
    },
    generateBundle() {
      for (const [path, fileName] of visualAssets)
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(fileURLToPath(new URL(path, import.meta.url))),
        });
    },
    transformIndexHtml(html) {
      const description =
        "A static demo of the herdr-mise agent-state kitchen visualizer.";
      return {
        html: html.replace(
          "<title>herdr-mise</title>",
          "<title>herdr-mise demo</title>",
        ),
        tags: [
          {
            tag: "meta",
            attrs: { name: "description", content: description },
            injectTo: "head",
          },
          ...["og:image", "twitter:image"].map((name) => ({
            tag: "meta",
            attrs: {
              [name.startsWith("og:") ? "property" : "name"]: name,
              content: "https://herdr-mise.s11a.com/og.png",
            },
            injectTo: "head" as const,
          })),
          ...["og:image:alt", "twitter:image:alt"].map((name) => ({
            tag: "meta",
            attrs: {
              [name.startsWith("og:") ? "property" : "name"]: name,
              content:
                "Codex blocked on checkout-api in the herdr-mise DEMO SERVICE kitchen.",
            },
            injectTo: "head" as const,
          })),
          {
            tag: "meta",
            attrs: { property: "og:title", content: "herdr-mise demo" },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { property: "og:description", content: description },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { name: "twitter:title", content: "herdr-mise demo" },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { name: "twitter:description", content: description },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: { name: "twitter:card", content: "summary_large_image" },
            injectTo: "head",
          },
        ],
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  const visual = mode === "visual";
  return {
    plugins: [react(), ...(visual ? [visualSite()] : [])],
    server: {
      host: "127.0.0.1",
      // set b/c maintainer homelab server
      // remove or re-configure for your local
      allowedHosts: ["herdr-mise.dev.s11a.com"],
      port: 8686,
      strictPort: true,
    },
    build: {
      ...(visual ? { outDir: "dist-visual" } : {}),
      manifest: true,
      minify: "terser",
      terserOptions: { compress: { passes: 2 }, mangle: true },
    },
  };
});
