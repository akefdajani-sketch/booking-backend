const express = require("express");
const app = express();

const PORT = process.env.PORT || 3001;

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
