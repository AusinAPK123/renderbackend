const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

/* 🔑 INIT FIREBASE ADMIN */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: "https://luxta-a2418.firebaseio.com"
});

const db = admin.database();

/* 🧪 TEST */
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.post("/test", async (req, res) => {
  await db.ref("test/value").set(Date.now());
  res.send("OK");
});

/* 🪙 ADD COIN */
app.post("/add-coin", async (req, res) => {
  const { uid } = req.body;

  if (!uid) {
    return res.status(400).json({ error: "Missing uid" });
  }

  const ref = db.ref("users/" + uid + "/coin");
  await ref.transaction(c => (c || 0) + 30);

  res.json({ ok: true });
});

/* 🚀 START */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});


app.get("/ping", (req, res) => {
  res.send("OK");
});
