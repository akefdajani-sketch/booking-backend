// index.js (root entry point for Render)
// Render runs: node index.js
// Keep this file tiny and forward to server.js

console.log("BOOT: running root index.js -> server.js");

// Helpful in Render logs (won't change behavior)
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

require("./server");
