const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());

/* =====================================================
   FIREBASE INIT
===================================================== */
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
   2. GET TOKEN (LINK – 24H / MAX 2)
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

    // Qua ngày → reset
    if (data.date !== today) {
      data = { count: 0, date: today };
    }

    // Đủ lượt hôm nay
    if (data.count >= 2) {
      return res.json({
        ok: true,
        countToday: data.count
      });
    }

    const token = crypto.randomBytes(16).toString("hex");
    const now = Date.now();

    await db.ref(`sessions/${token}`).set({
      uid,
      linkId,
      startAt: now,
      expiresAt: now + 6 * 60 * 60 * 1000, // 6 tiếng
      used: false
    });

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

    if (!tokenData || tokenData.uid !== uid) {
      return res.status(400).json({ ok: false, error: "Token không tồn tại" });
    }

    if (Date.now() > tokenData.expiresAt) {
      return res.status(400).json({ ok: false, error: "Token đã hết hạn" });
    }

    if (tokenData.used) {
      return res.status(400).json({
        ok: false,
        error: "Token đã được sử dụng",
        usedAt: tokenData.usedAt || null
      });
    }

    // Anti-cheat: quá nhanh
    if (Date.now() - tokenData.startAt < 15000) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(400).json({ ok: false, error: "Phát hiện gian lận" });
    }

    await db.ref(`users/${uid}/coins`).transaction(c => (c || 0) + 30);
    await db.ref(`users/${uid}/xp`).transaction(x => (x || 0) + 5);

    await tokenRef.update({
      used: true,
      usedAt: Date.now()
    });

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
    if (!uid || score == null || !gameName) {
      return res.status(400).json({ ok: false, error: "Thiếu dữ liệu" });
    }

    const scoreRef = db.ref(`leaderboard/${gameName}/${uid}`);
    const snap = await scoreRef.get();

    // ❌ CHƯA THAM GIA → CÚT
    if (!snap.exists()) {
      return res.json({
        ok: false,
        error: "Chưa tham gia minigame"
      });
    }

    const current = snap.val();
    const bestscore = Number(current.bestscore) || 0;
    const newScore = Number(score) || 0;

    if (newScore > bestscore) {
      await scoreRef.update({
        bestscore: newScore,
        updatedAt: Date.now()
      });

      return res.json({ ok: true, newRecord: true });
    }

    res.json({ ok: true, newRecord: false });
  } catch (e) {
    console.error("SUBMIT SCORE ERROR:", e);
    res.status(500).json({ ok: false, error: "Lỗi lưu điểm" });
  }
});

/* =====================================================
   5. ROUTE KHÁC (GIỮ NGUYÊN)
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
