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
  const { uid, linkId } = req.body;
  const today = new Date().toISOString().slice(0,10);
  const linkRef = db.ref(`users/${uid}/links/${linkId}`);
  const snap = await linkRef.get();
  const data = snap.val() || { count: 0, date: today };

  // Reset ngày nếu khác
  if(data.date !== today){
    data.count = 0;
    data.date = today;
  }

  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  await db.ref(`sessions/${token}`).set({
    uid,
    linkId,
    startAt: now,
    expiresAt: now + 1*60*60*1000,
    deleteAt: now + 6*60*60*1000,
    used: false
  });

  res.json({
    ok: true,
    token,
    countToday: data.count
  });
});

/* =====================================================
   3. USE TOKEN (ANTI-CHEAT + COUNT + COIN + XP)
===================================================== */
app.post("/use-token", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ ok: false, error: "Thiếu token" });
    }

    const tokenRef = db.ref(`sessions/${token}`);
    const snap = await tokenRef.get();
    const tokenData = snap.val();

    // ❌ token không tồn tại
    if (!tokenData) {
      return res.status(400).json({ ok: false, error: "Token không tồn tại" });
    }

    const { uid, linkId, startAt, expiresAt, used } = tokenData;

    // ❌ hết hạn
    if (Date.now() > expiresAt) {
      return res.status(400).json({ ok: false, error: "Token đã hết hạn" });
    }

    // ❌ đã dùng
    if (used) {
      return res.status(400).json({
        ok: false,
        error: "Token đã được sử dụng",
        usedAt: tokenData.usedAt || null
      });
    }

    // ❌ anti-cheat: quá nhanh
    if (Date.now() - startAt < 15000) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(400).json({
        ok: false,
        error: "Phát hiện gian lận"
      });
    }

    /* =========================
       UPDATE LINK COUNT (SERVER)
    ========================== */
    const today = new Date().toISOString().slice(0, 10);
    const linkRef = db.ref(`users/${uid}/links/${linkId}`);

    await linkRef.transaction(link => {
      if (!link || link.date !== today) {
        return { count: 1, date: today };
      }
      return {
        count: (link.count || 0) + 1,
        date: today
      };
    });

    /* =========================
       CỘNG COIN + XP
    ========================== */
    await db.ref(`users/${uid}/coins`).transaction(c => (c || 0) + 30);
    await db.ref(`users/${uid}/xp`).transaction(x => (x || 0) + 5);

    /* =========================
       ĐÁNH DẤU TOKEN ĐÃ DÙNG
    ========================== */
    await tokenRef.update({
      used: true,
      usedAt: Date.now()
    });

    return res.json({
      ok: true,
      added: 30,
      xpAdded: 5
    });

  } catch (err) {
    console.error("USE TOKEN ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error"
    });
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

async function clean() {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  /* =========================
     1. CLEAN LINKS (theo user)
  ========================== */
  const usersSnap = await db.ref("users").get();
  const users = usersSnap.val() || {};

  for (const uid in users) {
    const links = users[uid].links || {};
    for (const linkId in links) {
      const link = links[linkId];
      if (link.date && link.date !== today) {
        await db.ref(`users/${uid}/links/${linkId}`).update({
          count: 0,
          date: today
        });
      }
    }
  }

  /* =========================
     2. CLEAN TOKENS (GLOBAL)
  ========================== */
  const sessionsSnap = await db.ref("sessions").get();
  const sessions = sessionsSnap.val() || {};

  for (const tokenId in sessions) {
    const token = sessions[tokenId];
    if (token.deleteAt && token.deleteAt < now) {
      await db.ref(`sessions/${tokenId}`).remove();
    }
  }

  console.log("🧹 Clean finished at", new Date().toISOString());
       }
// chạy clean ngay khi server khởi động
clean().catch(console.error);

// sau đó cứ 5 phút clean 1 lần nếu server còn sống
setInterval(() => {
  clean().catch(console.error);
}, 5 * 60 * 1000);

/* =====================================================
   START SERVER
===================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Hệ thống Luxta đang chạy tại port", PORT)
);
