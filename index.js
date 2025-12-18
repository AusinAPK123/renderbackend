const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://luxta-a2418-default-rtdb.firebaseio.com"
});

const db = admin.database();

// Thêm coin theo token
app.post("/use-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Missing token" });

    const tokenRef = db.ref(`sessions/${token}`);
    const tokenSnap = await tokenRef.get();
    const tokenData = tokenSnap.val();

    if (!tokenData) return res.status(404).json({ error: "Token không tồn tại" });
    if (tokenData.used) return res.status(400).json({ error: "Token đã sử dụng" });

    const now = Date.now();

    if (now < tokenData.expireAt) {
      // Token được dùng quá sớm, có thể trừ coin hoặc reject
      return res.status(400).json({ error: "Token chưa hết hạn" });
    }

    const uid = tokenData.uid;
    const COIN_ADD = 30;

    // Cộng coin cho user
    const coinRef = db.ref(`users/${uid}/coin`);
    await coinRef.transaction(current => (current || 0) + COIN_ADD);

    // Đánh dấu token đã dùng và set deleteAt
    await tokenRef.update({
      used: true,
      deleteAt: now + 6 * 60 * 60 * 1000 // xóa sau 6 giờ
    });

    res.json({ ok: true, uid, added: COIN_ADD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Cleanup token quá hạn
app.post("/cleanup-tokens", async (req, res) => {
  try {
    const now = Date.now();
    const sessionRef = db.ref("sessions");
    const snap = await sessionRef.get();
    const sessions = snap.val() || {};

    const toDelete = Object.entries(sessions)
      .filter(([key, val]) => val.deleteAt && val.deleteAt <= now)
      .map(([key]) => key);

    await Promise.all(toDelete.map(key => sessionRef.child(key).remove()));

    res.json({ ok: true, deleted: toDelete.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
