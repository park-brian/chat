#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
  });
  response.end(message);
}

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export async function startServer(port = 8000, directory = process.cwd()) {
  const root = await realpath(directory);

  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method Not Allowed\n");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      sendText(response, 400, "Bad Request\n");
      return;
    }

    const segments = pathname.split(/[\\/]+/).filter(Boolean);
    if (
      segments.some(
        (segment) => segment.startsWith(".") || segment === "node_modules",
      )
    ) {
      sendText(response, 404, "Not Found\n");
      return;
    }

    const requestedPath = resolve(root, pathname.replace(/^[/\\]+/, ""));
    if (!isInside(root, requestedPath)) {
      sendText(response, 403, "Forbidden\n");
      return;
    }

    try {
      let filePath = requestedPath;
      let fileStats = await stat(filePath);

      if (fileStats.isDirectory()) {
        filePath = join(filePath, "index.html");
        fileStats = await stat(filePath);
      }

      const canonicalPath = await realpath(filePath);
      if (!fileStats.isFile() || !isInside(root, canonicalPath)) {
        sendText(response, 404, "Not Found\n");
        return;
      }

      response.writeHead(200, {
        "Content-Type":
          MIME_TYPES[extname(canonicalPath).toLowerCase()] ??
          "application/octet-stream",
        "Content-Length": fileStats.size,
        "X-Content-Type-Options": "nosniff",
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = createReadStream(canonicalPath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      const statusCode = error?.code === "EACCES" ? 403 : 404;
      sendText(
        response,
        statusCode,
        statusCode === 403 ? "Forbidden\n" : "Not Found\n",
      );
    }
  });

  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", ready);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.argv[2] ? Number(process.argv[2]) : 8000;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const server = await startServer(port);
  console.log(
    `Serving ${process.cwd()} at http://localhost:${server.address().port}`,
  );
}
