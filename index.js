const express = require("express");
const app = express();

const PORT = process.env.PORT || 3001;

// Temporary in-memory services list (later this will come from a database)
const services = [
  {
    id: 1,
    tenant: "Salon Bella",
    name: "Women's Haircut & Blow-dry",
    durationMinutes: 60,
    price: 35,
  },
  {
    id: 2,
    tenant: "Yoga Studio Flow",
    name: "Evening Vinyasa Class",
    durationMinutes: 75,
    price: 12,
  },
  {
    id: 3,
    tenant: "Birdie Golf",
    name: "60-min Simulator Session",
    durationMinutes: 60,
    price: 25,
  },
];

// Health check (root)
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

// New endpoint: list services
app.get("/api/services", (req, res) => {
  res.json({ services });
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
