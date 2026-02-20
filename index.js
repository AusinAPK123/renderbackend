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
   TOKEN HELPERS
===================================================== */
const SESSION_TTL_MS = 45 * 60 * 1000; // 45 phút

function genToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}


/* =====================================================
   AUTH MIDDLEWARE (SESSION TOKEN)
===================================================== */
const authenticate = async (req, res, next) => {
  try {
    const sessionToken = req.headers["x-session-token"];
    if (!sessionToken) return res.status(401).json({ ok: false });

    const ref = db.ref(`userSessions/${sessionToken}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(401).json({ ok: false });

    const s = snap.val();
    if (!s.expiresAt || Date.now() > s.expiresAt) {
      await ref.remove();
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    req.user = { uid: s.uid };
    next();
  } catch (err) {
    res.status(500).json({ ok: false });
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
   LOGIN -> TRẢ USER TOKEN
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

    // user token dài hạn
    const userToken = genToken(32);
    await db.ref(`userAuthTokens/${userToken}`).set({
      uid,
      createdAt: Date.now(),
      revoked: false
    });

    return res.json({
      ok: true,
      uid,
      token: userToken, // client đang lấy data.token để lưu SecureStore
      rulesAccepted: !!userData.rulesAccepted,
      coins: userData.coins || 0
    });
  } catch {
    return res.status(401).json({ ok: false, error: "Sai email hoặc mật khẩu!" });
  }
});

/* =====================================================
   ISSUE SESSION FROM USER TOKEN
===================================================== */
app.post("/auth/issue-session", async (req, res) => {
  try {
    const userToken = req.headers["x-user-token"];
    if (!userToken) return res.status(401).json({ ok: false });

    const authSnap = await db.ref(`userAuthTokens/${userToken}`).get();
    if (!authSnap.exists()) return res.status(401).json({ ok: false });

    const authData = authSnap.val();
    if (authData.revoked) return res.status(401).json({ ok: false });

    const sessionToken = genToken(20);
    const now = Date.now();

    await db.ref(`userSessions/${sessionToken}`).set({
      uid: authData.uid,
      userToken,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });

    return res.json({
      ok: true,
      sessionToken,
      expiresAt: now + SESSION_TTL_MS
    });
  } catch (err) {
    return res.status(500).json({ ok: false });
  }
});


const getTokenLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 phút
  max: 3, // tối đa 3 lần
  message: { ok: false, error: "Quá nhiều yêu cầu, thử lại sau" },
  keyGenerator: (req) => req.user?.uid || req.ip
});

app.post("/get-room", authenticate, async (req, res) => {
  try {
    const uid1 = req.user.uid;        // Người gửi request
    const uid2 = req.body.uid2;       // Người kia

    if (!uid2) return res.json({ ok: false, error: "missing uid2" });

    // Tạo room ID theo cách ổn định
    const roomId = [uid1, uid2].sort().join("_");

    // Kiểm tra trong DB
    const snap = await db.ref(`rooms/${roomId}`).get();

    if (!snap.exists()) {
      // Tạo room mới
      await db.ref(`rooms/${roomId}`).set({
        members: {
          [uid1]: true,
          [uid2]: true,
        },
        createdAt: Date.now(),
      });
    }

    return res.json({ ok: true, roomId });

  } catch (err) {
    return res.json({ ok: false });
  }
});

const lastMsgTime = {};

function msgrateLimit(req, res, next) {
  const uid = req.user.uid;
  const now = Date.now();

  if (lastMsgTime[uid] && now - lastMsgTime[uid] < 1000) {
    return res.json({ ok: false, error: "slow down" });
  }

  lastMsgTime[uid] = now;
  next();
}

app.post("/get-user-list", authenticate, async (req, res) => {
  try {
    const myUid = req.user.uid;
    const snap = await db.ref("users").get();
    const users = snap.val() || {};

    const list = Object.entries(users)
      .filter(([uid]) => uid !== myUid)
      .map(([uid, u]) => ({
        uid,
        name: u?.name || "Unknown",
        level: Number(u?.level ?? u?.lv ?? 0),
      }))
      .sort((a, b) => b.level - a.level);

    return res.json({ ok: true, users: list });
  } catch (err) {
    console.error("GET_USER_LIST ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


app.post("/upmessage", authenticate, msgrateLimit, async (req, res) => {
  try {
    const sender = req.user.uid;
    const { roomId, message } = req.body;

    if (!roomId || !message) {
      return res.json({ ok: false, error: "missing fields" });
    }

    // Validate roomId format: chỉ đúng 2 uid
    const parts = roomId.split("_");
    if (parts.length !== 2) {
      return res.json({ ok: false, error: "invalid roomId" });
    }

    const [uidA, uidB] = parts;
    
    // Kiểm tra: sender phải là 1 trong 2 uid
    if (sender !== uidA && sender !== uidB) {
      return res.json({ ok: false, error: "not allowed" });
    }

    // Lấy lại room (reload để tránh dùng snap cũ)
    let roomSnap = await db.ref(`rooms/${roomId}`).get();

    // Nếu room chưa tồn tại → auto create
    if (!roomSnap.exists()) {
      await db.ref(`rooms/${roomId}`).set({
        members: {
          [uidA]: true,
          [uidB]: true
        },
        createdAt: Date.now(),
      });

      // Load lại tránh members undefined
      roomSnap = await db.ref(`rooms/${roomId}`).get();
    }

    const roomData = roomSnap.val();
    const members = roomData.members || {};

    // Kiểm tra sender có thuộc room không
    if (!members[sender]) {
      return res.json({ ok: false, error: "not allowed" });
    }

    // Ghi tin nhắn
    const msgRef = db.ref(`messages/${roomId}`).push();
    await msgRef.set({
      sender,
      message,
      time: Date.now()
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error("UPMESSAGE ERROR:", err);
    return res.json({ ok: false });
  }
});

app.post("/get-messages", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { roomId, limit = 100 } = req.body;

    if (!roomId) return res.json({ ok: false, error: "missing roomId" });

    const parts = roomId.split("_");
    if (parts.length !== 2) return res.json({ ok: false, error: "invalid roomId" });
    if (!parts.includes(uid)) return res.json({ ok: false, error: "not allowed" });

    const roomSnap = await db.ref(`rooms/${roomId}`).get();
    if (!roomSnap.exists()) return res.json({ ok: true, messages: [] });

    const msgsSnap = await db.ref(`messages/${roomId}`).limitToLast(Number(limit) || 100).get();
    const raw = msgsSnap.val() || {};

    const messages = Object.entries(raw)
      .map(([id, m]) => ({
        id,
        sender: m.sender || "",
        text: m.message || "",
        time: m.time || 0,
      }))
      .sort((a, b) => a.time - b.time);

    return res.json({ ok: true, messages });
  } catch (err) {
    console.error("GET_MESSAGES ERROR:", err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

app.post("/create-order", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { type, name, price = 0, content = "", bankAccount = "", bankName = "", bankProvider = "" } = req.body || {};

    if (!type || !name) return res.status(400).json({ ok: false, error: "Missing fields" });
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ ok: false, error: "Invalid price" });

    const coinRef = db.ref(`users/${uid}/coins`);
    const spend = await coinRef.transaction((current) => {
      const coin = Number(current);
      if (!Number.isFinite(coin)) return;     // abort: coin data lỗi
      if (coin < p) return;                   // abort: thiếu coin
      return coin - p;
    });

    if (!spend.committed) {
      const dbCoin = Number(spend.snapshot?.val());
      if (!Number.isFinite(dbCoin)) {
        return res.status(400).json({ ok: false, error: "Coin data invalid" });
      }
      return res.status(400).json({ ok: false, error: `Không đủ coin (${dbCoin})` });
    }

    // ... tạo order như cũ
  } catch (err) {
    console.error("CREATE_ORDER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


app.get("/my-orders", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const idxSnap = await db.ref(`ordersByUser/${uid}`).get();
    const idx = idxSnap.val() || {};
    const ids = Object.keys(idx);

    const jobs = ids.map(async (id) => {
      const s = await db.ref(`orders/${id}`).get();
      return s.exists() ? { id, ...s.val() } : null;
    });
    const rows = (await Promise.all(jobs)).filter(Boolean).sort((a, b) => b.date - a.date);

    return res.json({ ok: true, orders: rows });
  } catch (err) {
    console.error("MY_ORDERS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});



/* =====================================================
   2. GET TOKEN (LINK – 24H / MAX 2)
===================================================== */
app.post("/get-token", authenticate, getTokenLimiter, async (req, res) => {
  const { linkId } = req.body;
  const uid = req.user.uid;
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
      name: userData.name,
      coins: userData.coins || 0,
      axp: userData.axp || 0,
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

    /* =========================
       1️⃣ CLAIM TOKEN (ATOMIC)
    ========================== */
    const claim = await tokenRef.transaction(current => {
      if (!current) return current; // không tồn tại
      if (current.used) return;     // đã dùng → abort

      // hết hạn
      if (Date.now() > current.expiresAt) return;

      // anti cheat quá nhanh
      if (Date.now() - current.startAt < 15000) {
        current.flagCheat = true;
        return current; // vẫn commit để đánh dấu
      }

      current.used = true;
      current.usedAt = Date.now();
      return current;
    });

    // ❌ transaction thất bại (token đã used)
    if (!claim.committed) {
      return res.status(400).json({
        ok: false,
        error: "Token đã được sử dụng hoặc không hợp lệ"
      });
    }

    const tokenData = claim.snapshot.val();

    if (!tokenData) {
      return res.status(400).json({
        ok: false,
        error: "Token không tồn tại"
      });
    }

    // ❌ nếu bị flag cheat
    if (tokenData.flagCheat) {
      await db.ref(`users/${tokenData.uid}/coins`).set(-999999);
      return res.status(400).json({
        ok: false,
        error: "Phát hiện gian lận"
      });
    }

    const { uid, linkId } = tokenData;

    /* =========================
       2️⃣ UPDATE LINK COUNT
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
       3️⃣ CỘNG COIN + XP
    ========================== */
    await db.ref(`users/${uid}/coins`)
      .transaction(c => (c || 0) + 30);

    await db.ref(`users/${uid}/axp`).transaction(v => (v || 0) + 5);

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

app.post("/accept-rules", authenticate, async (req, res) => {
  const uid = req.user.uid;
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
