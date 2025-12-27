// index.js (root entry point for Render)
// Keep this file tiny: Render runs `node index.js`, and we forward to server.js

console.log("BOOT: running root index.js -> server.js");
require("./server");
