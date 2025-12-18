const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: "https://luxta-a2418-default-rtdb.firebaseio.com"
});

const db = admin.database();

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.post("/add-coin", async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: "Missing uid" });
    }

    const COIN_ADD = 30;

    const coinRef = db.ref(`users/${uid}/coin`);

    await coinRef.transaction((current) => {
      return (current || 0) + COIN_ADD;
    });

    res.json({ ok: true, added: COIN_ADD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
