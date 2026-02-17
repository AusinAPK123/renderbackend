const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

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
   AUTH MIDDLEWARE (SESSION TOKEN)
===================================================== */
const authenticate = async (req, res, next) => {
  try {
    const { uid, sessionToken } = req.body;

    if (!uid || !sessionToken) {
      return res.status(401).json({
        ok: false,
        error: "Yêu cầu đăng nhập lại"
      });
    }

    const snap = await db.ref(`users/${uid}/session/token`).get();

    if (!snap.exists() || snap.val() !== sessionToken) {
      return res.status(401).json({
        ok: false,
        error: "Phiên đăng nhập không hợp lệ"
      });
    }

    req.user = { uid }

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "Lỗi xác thực hệ thống"
    });
  }
};


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

const getTokenLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 phút
  max: 3, // tối đa 3 lần
  message: { ok: false, error: "Quá nhiều yêu cầu, thử lại sau" },
  keyGenerator: (req) => req.body.uid || req.ip // Ưu tiên UID
});

/* =====================================================
   2. GET TOKEN (LINK – 24H / MAX 2)
===================================================== */
app.post("/get-token", authenticate, getTokenLimiter, async (req, res) => {
  const { uid, linkId } = req.body;
  const today = new Date().toISOString().slice(0,10);
  const linkRef = db.ref(`users/${uid}/links/${linkId}`);
  const snap = await linkRef.get();
  const data = snap.val() || { count: 0, date: today };

  // Reset ngày nếu khác
  if(data.date !== today){
    data.count = 0;
    data.date = today;
    await linkRef.set(data);
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

// Giới hạn Web chỉ được gọi tối đa 20 lần / 1 phút để tránh bị bot spam quét UID
const publicLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { ok: false }
});

app.get("/public-link-check", publicLimiter, async (req, res) => {
  try {
    const { uid, linkId } = req.query;
    if (!uid || !linkId) return res.json({ ok: false, error: "Missing ID" });

    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.ref(`users/${uid}/links/${linkId}`).get();
    const data = snap.val() || { count: 0, date: today };

    // Trả về số lần vượt nếu đúng ngày hôm nay, ngược lại trả về 0
    res.json({
      ok: true,
      countToday: data.date === today ? data.count : 0
    });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post("/get-user-data", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;   // 👈 LẤY TỪ AUTH, KHÔNG TỪ BODY

    const snap = await db.ref(`users/${uid}`).get();
    const userData = snap.val() || {};

    res.json({
      ok: true,
      coins: userData.coins || 0,
      xp: userData.xp || 0,
      rulesAccepted: !!userData.rulesAccepted,
      links: userData.links || {}
    });

  } catch (err) {
    res.status(500).json({ ok: false });
  }
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
    await tokenRef.transaction(token => {
      if (!token) return token;
    
      if (token.used) return token; // token đã được dùng => reject transaction
    
      token.used = true;
      token.usedAt = Date.now();
      return token;
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
   4. MULTI-GAME LEADERBOARD (with mode)
===================================================== */
app.post("/submit-score", authenticate, async (req, res) => {
  try {
    // Thêm 'order' vào destructuring (mặc định là 'desc' nếu không gửi)
    const uid = req.user.uid;
    const { score, gameName, mode, order = 'desc' } = req.body;
    
    if (!uid || score == null || !gameName) {
      return res.status(400).json({ ok: false, error: "Thiếu dữ liệu" });
    }

    let scorePath = `leaderboard/${gameName}`;
    if (mode) scorePath += `/${mode}`;
    scorePath += `/${uid}`;

    const scoreRef = db.ref(scorePath);
    const snap = await scoreRef.get();

    if (!snap.exists()) {
      return res.json({ ok: false, error: "Chưa tham gia minigame" });
    }

    const current = snap.val();
    const bestscore = Number(current.bestscore) || (order === 'asc' ? Infinity : 0);
    const newScore = Number(score);

    // 🔥 LOGIC SO SÁNH LINH HOẠT
    let isNewRecord = false;
    if (order === 'asc') {
      // Game tính thời gian: score mới phải NHỎ HƠN score cũ
      if (newScore < bestscore) isNewRecord = true;
    } else {
      // Game tính điểm: score mới phải LỚN HƠN score cũ
      if (newScore > bestscore) isNewRecord = true;
    }

    if (isNewRecord) {
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
app.post("/spend-coin", authenticate, async (req, res) => {
  const { type } = req.body;
  const uid = req.user.uid;

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

  const updates = {};

  /* =========================
     1. CLEAN LINKS
  ========================== */
  const usersSnap = await db.ref("users").get();
  const users = usersSnap.val() || {};

  for (const uid in users) {
    const links = users[uid].links;
    if (!links) continue;

    for (const linkId in links) {
      const link = links[linkId];

      if (link.date && link.date !== today) {
        updates[`users/${uid}/links/${linkId}/count`] = 0;
        updates[`users/${uid}/links/${linkId}/date`] = today;
      }
    }
  }

  /* =========================
     2. CLEAN TOKENS
  ========================== */
  const sessionsSnap = await db.ref("sessions").get();
  const sessions = sessionsSnap.val() || {};

  for (const tokenId in sessions) {
    const token = sessions[tokenId];
    if (token.deleteAt && token.deleteAt < now) {
      updates[`sessions/${tokenId}`] = null;
    }
  }
  
  /* =========================
     APPLY UPDATES (1 REQUEST)
  ========================== */
  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
  console.log("🧹 Clean finished at", new Date().toISOString());
}

/* =====================================================
   NOTIFICATIONS ROUTE
===================================================== */
app.get("/notifications", async (req, res) => {
  try {
    const snap = await db.ref("notifications").get();
    const data = snap.val() || {};

    // Convert object → array
    const list = Object.keys(data).map(id => ({
      id,
      title: data[id].title || "",
      content: data[id].content || "",
      createdAt: data[id].createdAt || 0
    }));

    // Sort: mới nhất lên đầu
    list.sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      ok: true,
      notifications: list
    });

  } catch (err) {
    console.error("NOTIFICATIONS ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});
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
