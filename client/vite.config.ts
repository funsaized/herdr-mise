import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const visualAssets = [
  ["../docs/assets/herdr-mise-tui-demo.gif", "tui-demo.gif"],
  ["../docs/assets/herdr-mise-tui-blocked.png", "tui-demo-poster.png"],
  ["../docs/assets/working-service-1280x720.png", "og.png"],
] as const;

function visualSite(): Plugin {
  return {
    name: "visual-site",
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
          {
            tag: "link",
            attrs: {
              rel: "icon",
              href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23231f20'/%3E%3Cpath d='M14 42h36v8H14zm6-28h24v8H20zm-6 14h36v8H14z' fill='%23f4ead7'/%3E%3C/svg%3E",
            },
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
                "The herdr-mise demo kitchen showing agent stations and the DEMO SERVICE placard.",
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
