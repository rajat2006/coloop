import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const port = 4210;

createServer((request, response) => {
  const path = request.url === "/" ? "index.html" : request.url.slice(1).split("?")[0];
  response.setHeader("Content-Type", path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
  createReadStream(join(directory, path)).on("error", () => {
    response.statusCode = 404;
    response.end("Not found");
  }).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Owner setup prototype: http://127.0.0.1:${port}/?variant=A`);
});
