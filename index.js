const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());

// --- KHỞI TẠO FIREBASE ---
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
  databaseURL: "https://luxta-a2418-default-rtdb.firebaseio.com"
});

const db = admin.database();

/* =====================================================
   HELPER LOGIN (GIỮ NGUYÊN)
===================================================== */
async function loginWithFirebase(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { uid: data.localId };
}

/* =====================================================
   1. LOGIN & SESSION
===================================================== */
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { uid } = await loginWithFirebase(email, password);

    const userRef = db.ref(`users/${uid}`);
    const snap = await userRef.get();
    const userData = snap.val() || {};

    if (userData.coins < 0) {
      return res.status(403).json({ ok: false, error: "Tài khoản bị phong ấn!" });
    }

    const sessionToken = crypto.randomBytes(20).toString("hex");
    await userRef.child("session").set({
      token: sessionToken,
      lastLogin: Date.now()
    });

    res.json({
      ok: true,
      uid,
      token: sessionToken,
      rulesAccepted: !!userData.rulesAccepted,
      coins: userData.coins || 0
    });
  } catch {
    res.status(401).json({ ok: false, error: "Sai email hoặc mật khẩu!" });
  }
});

/* =====================================================
   2. GET TOKEN (LINK SYSTEM – 24H / MAX 2 LẦN)
===================================================== */
app.post("/get-token", async (req, res) => {
  try {
    const { uid, linkId } = req.body;
    if (!uid || !linkId) {
      return res.status(400).json({ ok: false });
    }

    const today = new Date().toISOString().slice(0, 10);
    const linkRef = db.ref(`users/${uid}/links/${linkId}`);
    const snap = await linkRef.get();

    let data = snap.val() || { count: 0, date: today };

    // Qua ngày mới → reset
    if (data.date !== today) {
      data = { count: 0, date: today };
    }

    // Đã vượt tối đa hôm nay
    if (data.count >= 2) {
      return res.json({
        ok: true,
        countToday: data.count
      });
    }

    // Tạo token
    const token = crypto.randomBytes(16).toString("hex");

    await db.ref(`sessions/${token}`).set({
      uid,
      linkId,
      startAt: Date.now(),
      used: false
    });

    // Tăng count
    await linkRef.set({
      count: data.count + 1,
      date: today
    });

    res.json({
      ok: true,
      token,
      countToday: data.count + 1
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =====================================================
   3. USE TOKEN (ANTI-CHEAT + COIN + XP)
===================================================== */
app.post("/use-token", async (req, res) => {
  try {
    const { token, uid } = req.body;

    const tokenRef = db.ref(`sessions/${token}`);
    const snap = await tokenRef.get();
    const tokenData = snap.val();

    if (!tokenData || tokenData.used || tokenData.uid !== uid) {
      return res.status(400).json({ ok: false, error: "Token không hợp lệ" });
    }

    // ⛔ Anti cheat: chạy quá nhanh
    if (Date.now() - tokenData.startAt < 15000) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(400).json({ ok: false, error: "Phát hiện gian lận" });
    }

    // ✅ Cộng coin
    await db.ref(`users/${uid}/coins`).transaction(c => (c || 0) + 30);

    // ✅ Cộng XP cố định
    await db.ref(`users/${uid}/xp`).transaction(x => (x || 0) + 5);

    // ✅ Huỷ token
    await tokenRef.update({ used: true });

    res.json({ ok: true, added: 30, xpAdded: 5 });
  } catch {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =====================================================
   4. MULTI-GAME LEADERBOARD
===================================================== */
app.post("/submit-score", async (req, res) => {
  try {
    const { uid, score, gameName } = req.body;
    if (!gameName) {
      return res.status(400).json({ error: "Thiếu tên game!" });
    }

    const scoreRef = db.ref(`leaderboard/${gameName}/${uid}`);
    const snap = await scoreRef.get();
    const current = snap.val() || { score: 0 };

    if (score > current.score) {
      await scoreRef.set({
        score,
        updatedAt: Date.now()
      });
      return res.json({ ok: true, newRecord: true });
    }

    res.json({ ok: true, newRecord: false });
  } catch {
    res.status(500).json({ error: "Lỗi lưu điểm" });
  }
});

/* =====================================================
   5. CÁC ROUTE KHÁC (GIỮ NGUYÊN)
===================================================== */
app.post("/spend-coin", async (req, res) => {
  const { uid, type } = req.body;

  const costMap = {
    revive: 100,
    removeRow: 30,
    removeCol: 30,
    removeAll: 90
  };

  const cost = costMap[type];
  if (!cost) {
    return res.status(400).json({ ok: false, error: "Unknown type" });
  }

  const coinRef = db.ref(`users/${uid}/coins`);
  const snap = await coinRef.get();

  if ((snap.val() || 0) < cost) {
    return res.json({ ok: false, error: "Không đủ coin" });
  }

  await coinRef.transaction(c => (c || 0) - cost);
  res.json({ ok: true });
});

app.post("/add-xp", async (req, res) => {
  const { uid, xp } = req.body;
  await db.ref(`users/${uid}/xp`).transaction(c => (c || 0) + xp);
  res.json({ ok: true });
});

app.post("/accept-rules", async (req, res) => {
  const { uid } = req.body;
  await db.ref(`users/${uid}/rulesAccepted`).set(true);
  res.json({ ok: true });
});

app.get("/check-rules", async (req, res) => {
  const { uid } = req.query;
  const snap = await db.ref(`users/${uid}`).get();
  const data = snap.val() || {};
  res.json({
    ok: true,
    rulesAccepted: !!data.rulesAccepted,
    coins: data.coins || 0
  });
});

/* =====================================================
   START SERVER
===================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Hệ thống Luxta đang chạy tại port", PORT)
);
