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

function getMaxAllowedLinks(levelRaw) {
  const lv = Math.max(0, Number(levelRaw || 0));
  return Math.min(20, 5 + lv);
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

/* =====================================================
   DAILY CHECK-IN
===================================================== */
const CHECKIN_REWARDS = [5, 5, 5, 10, 10, 15, 20];

// Day key theo UTC+7 để ổn định theo giờ VN
function getTodayKeyVN() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10);
}

function getPrevDayKeyVN(todayKey) {
  const d = new Date(`${todayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

app.get("/checkin-status", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const today = getTodayKeyVN();

    const snap = await db.ref(`users/${uid}/checkin`).get();
    const info = snap.val() || {};
    const streak = Number(info.streak || 0);
    const claimedToday = info.lastDate === today;
    const nextDayIndex = claimedToday ? streak % 7 : streak % 7;
    const reward = CHECKIN_REWARDS[nextDayIndex];

    return res.json({
      ok: true,
      uid,
      claimedToday,
      canClaim: !claimedToday,
      streak,
      reward,
    });
  } catch (err) {
    console.error("CHECKIN_STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/checkin-claim", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const today = getTodayKeyVN();
    const prevDay = getPrevDayKeyVN(today);

    const userRef = db.ref(`users/${uid}`);

    let result = { ok: false, error: "Claim failed" };

    const tx = await userRef.transaction((user) => {
      if (!user || typeof user !== "object") {
        result = { ok: false, error: "User not found" };
        return user;
      }

      const checkin = user.checkin || {};
      if (checkin.lastDate === today) {
        result = { ok: false, error: "Ban da diem danh hom nay" };
        return; // abort
      }

      const oldStreak = Number(checkin.streak || 0);
      const newStreak = checkin.lastDate === prevDay ? oldStreak + 1 : 1;
      const reward = CHECKIN_REWARDS[(newStreak - 1) % 7];

      user.coins = Number(user.coins || 0) + reward;
      user.checkin = {
        lastDate: today,
        streak: newStreak,
        updatedAt: Date.now(),
      };

      result = {
        ok: true,
        added: reward,
        streak: newStreak,
        nextReward: CHECKIN_REWARDS[newStreak % 7],
        coins: Number(user.coins || 0),
      };

      return user;
    });

    if (!tx.committed) {
      return res.status(400).json(result.ok ? { ok: false, error: "Claim failed" } : result);
    }

    return res.json(result);
  } catch (err) {
    console.error("CHECKIN_CLAIM ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

async function resolveUidForScore(req) {
  const sessionToken = req.headers["x-session-token"];
  if (sessionToken) {
    const snap = await db.ref(`userSessions/${sessionToken}`).get();
    if (!snap.exists()) return null;
    const s = snap.val() || {};
    if (!s.expiresAt || Date.now() > s.expiresAt) return null;
    return s.uid || null;
  }

  // fallback legacy web gửi uid trực tiếp
  const uid = String(req.body?.uid || "").trim();
  return uid || null;
}


/* =====================================================
   GAME CONFIG (generic)
===================================================== */
const GAME_META = {
  BlockL: {
    modeRequired: false,
    defaultMode: "ranked",
    defaultOrder: "desc",
    requireJoinForScore: true,
    entryFees: { ranked: 90 },
  },
  minesweeper: {
    modeRequired: true,
    defaultMode: "easy",
    defaultOrder: "asc", // thời gian thấp hơn rank cao hơn
    requireJoinForScore: true,
    // mua theo từng mode riêng
    entryFees: {
      easy: 90,
      medium: 90,
      hard: 90,
      no_flag: 90,
      impossible: 90,
    },
  },
};


function getGameMeta(gameName) {
  return GAME_META[String(gameName || "").trim()];
}

function isModeAllowed(gameName, mode) {
  const meta = getGameMeta(gameName);
  if (!meta) return false;

  // Game không mode: chỉ cho defaultMode
  if (!meta.modeRequired) {
    return mode === String(meta.defaultMode || "").toLowerCase();
  }

  // Game có mode: chỉ cho mode nằm trong entryFees
  const allowed = Object.keys(meta.entryFees || {});
  return allowed.includes(mode);
}


function normalizeMode(gameName, rawMode) {
  const meta = getGameMeta(gameName);
  if (!meta) return null;

  const mode = String(rawMode || meta.defaultMode || "").trim().toLowerCase();
  if (!mode) return null;
  if (!isModeAllowed(gameName, mode)) return null;

  return mode;
}




function getLeaderboardBasePath(gameName, mode) {
  const meta = getGameMeta(gameName);
  if (!meta) return null;
  if (meta.modeRequired) return `leaderboard/${gameName}/${mode}`;
  return `leaderboard/${gameName}`;
}

function getEntryFee(gameName, mode) {
  const meta = getGameMeta(gameName);
  if (!meta) return 0;
  return Number(meta.entryFees?.[mode] || 0);
}

/* =====================================================
   GAME REGISTER / GAME STATE
===================================================== */
app.post("/game-register", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const gameName = String(req.body?.gameName || "").trim();
    const meta = getGameMeta(gameName);
    if (!meta) return res.status(400).json({ ok: false, error: "Unsupported game" });

    const mode = normalizeMode(gameName, req.body?.mode);
    if (!mode) return res.status(400).json({ ok: false, error: "Invalid mode" });

    const fee = getEntryFee(gameName, mode);
    if (fee <= 0) {
      return res.status(400).json({ ok: false, error: "Mode nay khong can dang ky", uid });
    }

    const memberRef = db.ref(`gameMembers/${gameName}/${mode}/${uid}`);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists()) {
      return res.json({ ok: true, joined: true, alreadyJoined: true, fee: 0, uid });
    }

    // 1) Read coin trước (giống create-order)
    const coinRef = db.ref(`users/${uid}/coins`);
    const beforeSnap = await coinRef.get();
    const beforeCoin = Number(beforeSnap.val());

    if (!Number.isFinite(beforeCoin)) {
      return res.status(400).json({ ok: false, error: "Coin data invalid", uid });
    }

    if (beforeCoin < fee) {
      return res.status(400).json({
        ok: false,
        error: `Khong du coin (${beforeCoin})`,
        uid,
      });
    }

    // 2) Atomic spend
    const spend = await coinRef.transaction((current) => {
      const coin = Number(current ?? beforeCoin);
      if (!Number.isFinite(coin)) return;
      if (coin < fee) return;
      return coin - fee;
    });

    if (!spend.committed) {
      const latestCoin = Number((await coinRef.get()).val() ?? 0);
      return res.status(409).json({
        ok: false,
        uid,
        error: `So du thay doi, thu lai (${Number.isFinite(latestCoin) ? latestCoin : 0})`,
      });
    }

    await memberRef.set({
      joinedAt: Date.now(),
      feePaid: fee,
    });

    return res.json({
      ok: true,
      uid,
      joined: true,
      fee,
      coinsLeft: Number(spend.snapshot?.val() ?? 0),
    });
  } catch (err) {
    console.error("GAME_REGISTER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


app.get("/game-state", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const gameName = String(req.query?.gameName || "").trim();
    const meta = getGameMeta(gameName);
    if (!meta) return res.status(400).json({ ok: false, error: "Unsupported game" });

    const mode = normalizeMode(gameName, req.query?.mode);
    if (!mode) return res.status(400).json({ ok: false, error: "Invalid mode" });

    const memberSnap = await db.ref(`gameMembers/${gameName}/${mode}/${uid}`).get();
    const joined = memberSnap.exists();
    const joinedAt = joined ? Number(memberSnap.val()?.joinedAt || 0) : 0;

    const lbBase = getLeaderboardBasePath(gameName, mode);
    const lbSnap = await db.ref(lbBase).get();
    const raw = lbSnap.val() || {};

    const rows = Object.entries(raw)
      .map(([playerUid, v]) => ({
        uid: playerUid,
        name: v?.name || "Unknown",
        bestscore: Number(v?.bestscore || 0),
        updatedAt: Number(v?.updatedAt || 0),
      }))
      .sort((a, b) => {
        const order = meta.defaultOrder || "desc";
        return order === "asc" ? a.bestscore - b.bestscore : b.bestscore - a.bestscore;
      })
      .slice(0, 100);

    return res.json({ ok: true, gameName, mode, joined, joinedAt, rows });
  } catch (err) {
    console.error("GAME_STATE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ADMIN_UIDS = (process.env.ADMIN_UIDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

async function authenticateAdminStrict(req, res, next) {
  try {
    const adminToken = req.headers["x-admin-token"];
    const adminKey = req.headers["x-admin-key"];

    if (!adminToken || !adminKey) {
      return res.status(401).json({ ok: false, error: "Missing admin auth" });
    }
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      return res.status(403).json({ ok: false, error: "Invalid admin key" });
    }

    const tokenSnap = await db.ref(`userAuthTokens/${adminToken}`).get();
    if (!tokenSnap.exists()) return res.status(401).json({ ok: false, error: "Invalid admin token" });

    const tokenData = tokenSnap.val();
    if (tokenData.revoked) return res.status(401).json({ ok: false, error: "Token revoked" });

    const adminUid = tokenData.uid;
    const userSnap = await db.ref(`users/${adminUid}`).get();
    const userData = userSnap.val() || {};

    if (!userData.isAdmin) return res.status(403).json({ ok: false, error: "Not admin" });
    if (ADMIN_UIDS.length && !ADMIN_UIDS.includes(adminUid)) {
      return res.status(403).json({ ok: false, error: "Admin uid not allowed" });
    }

    req.admin = { uid: adminUid, name: userData.name || "Admin" };
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

async function auditAdmin(action, target, payload, adminInfo) {
  await db.ref("adminLogs").push({
    action,
    target,
    payload: payload || {},
    adminUid: adminInfo?.uid || "",
    adminName: adminInfo?.name || "",
    at: Date.now(),
  });
}

app.get("/admin/bootstrap", authenticateAdminStrict, async (req, res) => {
  return res.json({ ok: true, admin: req.admin });
});

// USERS
app.get("/admin/users", authenticateAdminStrict, async (req, res) => {
  const snap = await db.ref("users").get();
  const users = snap.val() || {};
  const rows = Object.entries(users).map(([uid, u]) => ({
    uid,
    name: u?.name || "",
    email: u?.email || "",
    coins: Number(u?.coins || 0),
    axp: Number(u?.axp || 0),
  }));
  res.json({ ok: true, users: rows });
});

// CREATE USER (đồng bộ Auth + RTDB, có rollback)
app.post("/admin/users", authenticateAdminStrict, async (req, res) => {
  let createdUid = null;
  try {
    const { name = "", email = "", password = "" } = req.body || {};
    const n = String(name).trim();
    const e = String(email).trim().toLowerCase();
    const p = String(password);

    if (!n || !e || !p) {
      return res.status(400).json({ ok: false, error: "Missing name/email/password" });
    }
    if (p.length < 6) {
      return res.status(400).json({ ok: false, error: "Password too short" });
    }

    // 1) Create Auth user
    const userRecord = await admin.auth().createUser({
      email: e,
      password: p,
      displayName: n,
    });
    createdUid = userRecord.uid;

    // 2) Create DB profile
    await db.ref(`users/${createdUid}`).set({
      name: n,
      email: e,
      coins: 0,
      axp: 0,
      rulesAccepted: false,
      createdAt: Date.now(),
    });

    await auditAdmin("user.create", createdUid, { email: e, name: n }, req.admin);
    return res.json({ ok: true, uid: createdUid });
  } catch (e) {
    // rollback nếu Auth đã tạo nhưng DB fail
    if (createdUid) {
      try { await admin.auth().deleteUser(createdUid); } catch {}
    }
    return res.status(400).json({ ok: false, error: e?.message || "Create user failed" });
  }
});


app.patch("/admin/users/:uid", authenticateAdminStrict, async (req, res) => {
  const uid = req.params.uid;
  const patch = req.body || {};
  const allowed = ["name", "coins", "axp"];
  const updates = {};

  for (const k of allowed) if (k in patch) updates[k] = patch[k];
  if ("coins" in updates) updates.coins = Number(updates.coins || 0);
  if ("axp" in updates) updates.axp = Number(updates.axp || 0);

  await db.ref(`users/${uid}`).update(updates);
  await auditAdmin("user.patch", uid, updates, req.admin);
  res.json({ ok: true });
});

// DELETE USER (đồng bộ Auth + RTDB)
app.delete("/admin/users/:uid", authenticateAdminStrict, async (req, res) => {
  const uid = String(req.params.uid || "").trim();
  if (!uid) return res.status(400).json({ ok: false, error: "Missing uid" });

  try {
    // Xoá DB trước (idempotent), thêm path cleanup nếu bạn cần
    const updates = {
      [`users/${uid}`]: null,
      [`ordersByUser/${uid}`]: null,
      // token/sessions nếu có map theo uid thì xoá thêm ở đây
    };
    await db.ref().update(updates);

    // Xoá Auth user
    await admin.auth().deleteUser(uid);

    await auditAdmin("user.delete", uid, {}, req.admin);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Delete user failed",
    });
  }
});

// ORDERS
app.get("/admin/orders/pending", authenticateAdminStrict, async (req, res) => {
  const idxSnap = await db.ref("ordersByStatus/pending").get();
  const idx = idxSnap.val() || {};
  const ids = Object.keys(idx);

  const rows = [];
  const fixes = {};

  for (const id of ids) {
    const s = await db.ref(`orders/${id}`).get();
    if (!s.exists()) {
      fixes[`ordersByStatus/pending/${id}`] = null;
      continue;
    }

    const order = s.val() || {};
    if (order.status !== "pending") {
      fixes[`ordersByStatus/pending/${id}`] = null;
      continue;
    }

    rows.push({ id, ...order });
  }

  if (Object.keys(fixes).length) {
    await db.ref().update(fixes); // tự sửa index lệch
  }

  rows.sort((a, b) => Number(b.date || 0) - Number(a.date || 0));
  res.json({ ok: true, orders: rows });
});


app.post("/admin/orders/:orderId/review", authenticateAdminStrict, async (req, res) => {
  const orderId = req.params.orderId;
  const { action, reason } = req.body || {};
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ ok: false, error: "Invalid action" });
  if (!reason || !String(reason).trim()) return res.status(400).json({ ok: false, error: "Reason required" });

  const orderRef = db.ref(`orders/${orderId}`);
  const tx = await orderRef.transaction((o) => {
     if (!o) return;
     const s = String(o.status || "").trim().toLowerCase();
     if (s !== "pending") return;
   
     o.status = action === "approve" ? "approved" : "rejected";
     o.reviewReason = String(reason).trim();
     o.reviewedBy = req.admin.uid;
     o.reviewedAt = Date.now();
     return o;
   });
   
   if (!tx.committed) {
     const nowSnap = await orderRef.get();
     return res.status(409).json({
       ok: false,
       error: "Order not pending",
       currentStatus: nowSnap.val()?.status || null,
     });
   }


  const order = tx.snapshot.val();
  const updates = {};
  updates[`ordersByStatus/pending/${orderId}`] = null;
  updates[`ordersByStatus/${order.status}/${orderId}`] = true;
  await db.ref().update(updates);

  if (order.status === "rejected") {
    await db.ref(`users/${order.uid}/coins`).transaction(c => Number(c || 0) + Number(order.price || 0));
  }

  await auditAdmin("order.review", orderId, { action, reason }, req.admin);
  res.json({ ok: true });
});

// NOTIFICATIONS
app.get("/admin/notifications", authenticateAdminStrict, async (req, res) => {
  const snap = await db.ref("notifications").get();
  const data = snap.val() || {};
  const list = Object.entries(data).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  res.json({ ok: true, notifications: list });
});

app.post("/admin/notifications", authenticateAdminStrict, async (req, res) => {
  const { title = "", content = "" } = req.body || {};
  if (!title.trim() || !content.trim()) return res.status(400).json({ ok: false, error: "Missing fields" });
  const ref = db.ref("notifications").push();
  await ref.set({ title: title.trim(), content: content.trim(), createdAt: Date.now() });
  await auditAdmin("notif.create", ref.key, { title }, req.admin);
  res.json({ ok: true, id: ref.key });
});

app.patch("/admin/notifications/:id", authenticateAdminStrict, async (req, res) => {
  const id = req.params.id;
  const { title, content } = req.body || {};
  const updates = {};
  if (title != null) updates.title = String(title).trim();
  if (content != null) updates.content = String(content).trim();
  updates.updatedAt = Date.now();
  await db.ref(`notifications/${id}`).update(updates);
  await auditAdmin("notif.update", id, updates, req.admin);
  res.json({ ok: true });
});

app.delete("/admin/notifications/:id", authenticateAdminStrict, async (req, res) => {
  const id = req.params.id;
  await db.ref(`notifications/${id}`).remove();
  await auditAdmin("notif.delete", id, {}, req.admin);
  res.json({ ok: true });
});



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
    const {
      type,
      name,
      price = 0,
      content = "",
      bankAccount = "",
      bankName = "",
      bankProvider = "",
    } = req.body || {};

    // 1) Validate input
    if (!type || !name) {
      return res.status(400).json({ ok: false, error: "Missing fields", uid });
    }

    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid price", uid });
    }

    // 2) Read current coin first
    const coinRef = db.ref(`users/${uid}/coins`);
    const beforeSnap = await coinRef.get();
    const beforeCoin = Number(beforeSnap.val());

    if (!Number.isFinite(beforeCoin)) {
      return res.status(400).json({ ok: false, error: "Coin data invalid", uid });
    }

    if (beforeCoin < p) {
      return res.status(400).json({
        ok: false,
        error: `Không đủ coin (${beforeCoin})`,
        uid,
      });
    }

    // 3) Atomic spend
    const spend = await coinRef.transaction((current) => {
      const coin = Number(current ?? beforeCoin);

      // Abort only when data invalid or race condition insufficient
      if (!Number.isFinite(coin)) return;
      if (coin < p) return;

      return coin - p;
    });

    if (!spend.committed) {
      const latestCoin = Number((await coinRef.get()).val() ?? 0);
      return res.status(409).json({
        ok: false,
        uid,
        error: `Số dư thay đổi, thử lại (${Number.isFinite(latestCoin) ? latestCoin : 0})`,
      });
    }

    const coinsLeft = Number(spend.snapshot?.val() ?? 0);

    // 4) Create order + indexes
    const orderRef = db.ref("orders").push();
    const orderId = orderRef.key;
    const now = Date.now();

    const order = {
      uid,
      type,
      name,
      price: p,
      status: "pending",
      content: content || "",
      date: now,
      bankAccount: bankAccount || "",
      bankName: bankName || "",
      bankProvider: bankProvider || "",
    };

    const updates = {};
    updates[`orders/${orderId}`] = order;
    updates[`ordersByUser/${uid}/${orderId}`] = true;
    updates[`ordersByStatus/pending/${orderId}`] = true;

    await db.ref().update(updates);

    return res.json({
      ok: true,
      uid,
      orderId,
      order,
      coinsLeft,
    });
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
  try {
    const { linkId } = req.body;
    const uid = req.user.uid;
    const today = new Date().toISOString().slice(0, 10);

    const linkNum = Number(linkId);
    if (!Number.isInteger(linkNum) || linkNum < 1 || linkNum > 20) {
      return res.status(400).json({ ok: false, error: "Invalid linkId" });
    }

    const userSnap = await db.ref(`users/${uid}`).get();
    const userData = userSnap.val() || {};
    const level = Number(userData.level ?? userData.lv ?? 0);
    const maxLink = getMaxAllowedLinks(level);

    if (linkNum > maxLink) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(403).json({ ok: false, error: "Phat hien gian lan link" });
    }

    const linkRef = db.ref(`users/${uid}/links/${linkNum}`);
    const snap = await linkRef.get();
    const data = snap.val() || { count: 0, date: today };

    if (data.date !== today) {
      data.count = 0;
      data.date = today;
      await linkRef.set(data);
    }

    if (Number(data.count || 0) >= 2) {
      return res.status(429).json({
        ok: false,
        error: "Hom nay ban da vuot du 2 lan cho link nay",
        countToday: Number(data.count || 0),
      });
    }

    const token = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    await db.ref(`sessions/${token}`).set({
      uid,
      linkId: String(linkNum),
      startAt: now,
      expiresAt: now + 1 * 60 * 60 * 1000,
      deleteAt: now + 6 * 60 * 60 * 1000,
      used: false,
    });

    return res.json({
      ok: true,
      token,
      countToday: Number(data.count || 0),
    });
  } catch (err) {
    console.error("GET_TOKEN ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
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
      uid,
      name: userData.name,
      email: userData.email || "",
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

    const claim = await tokenRef.transaction((current) => {
      if (!current) return current;
      if (current.used) return;
      if (Date.now() > current.expiresAt) return;

      if (Date.now() - current.startAt < 15000) {
        current.flagCheat = true;
        return current;
      }

      current.used = true;
      current.usedAt = Date.now();
      return current;
    });

    if (!claim.committed) {
      return res.status(400).json({
        ok: false,
        error: "Token đã được sử dụng hoặc không hợp lệ",
      });
    }

    const tokenData = claim.snapshot.val();
    if (!tokenData) {
      return res.status(400).json({
        ok: false,
        error: "Token không tồn tại",
      });
    }

    if (tokenData.flagCheat) {
      await db.ref(`users/${tokenData.uid}/coins`).set(-999999);
      return res.status(400).json({
        ok: false,
        error: "Phát hiện gian lận",
      });
    }

    const { uid, linkId } = tokenData;
    const linkNum = Number(linkId);

    if (!Number.isInteger(linkNum) || linkNum < 1 || linkNum > 20) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(403).json({ ok: false, error: "Phat hien gian lan link" });
    }

    const userSnap = await db.ref(`users/${uid}`).get();
    const userData = userSnap.val() || {};
    const level = Number(userData.level ?? userData.lv ?? 0);
    const maxLink = getMaxAllowedLinks(level);

    if (linkNum > maxLink) {
      await db.ref(`users/${uid}/coins`).set(-999999);
      return res.status(403).json({ ok: false, error: "Phat hien gian lan link" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const linkRef = db.ref(`users/${uid}/links/${linkNum}`);

    const countTx = await linkRef.transaction((link) => {
      if (!link || link.date !== today) return { count: 1, date: today };
      const current = Number(link.count || 0);
      if (current >= 2) return;
      return { count: current + 1, date: today };
    });

    if (!countTx.committed) {
      return res.status(429).json({ ok: false, error: "Vuot gioi han 2 lan/ngay" });
    }

    await db.ref(`users/${uid}/coins`).transaction((c) => (c || 0) + 30);
    await db.ref(`users/${uid}/axp`).transaction((v) => (v || 0) + 5);

    return res.json({
      ok: true,
      added: 30,
      xpAdded: 5,
    });
  } catch (err) {
    console.error("USE TOKEN ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
    });
  }
});

/* =====================================================
   4. MULTI-GAME LEADERBOARD (with mode)
===================================================== */
app.post("/submit-score", async (req, res) => {
  try {
    const uid = await resolveUidForScore(req);
    const { score, gameName, mode, order } = req.body || {};

    if (!uid || score == null || !gameName) {
      return res.status(400).json({ ok: false, error: "Thiếu dữ liệu" });
    }

    const meta = getGameMeta(gameName);
    if (!meta) return res.status(400).json({ ok: false, error: "Unsupported game" });

    const m = normalizeMode(gameName, mode);
    if (!m) return res.status(400).json({ ok: false, error: "Invalid mode" });

    // chỉ mode có phí mới bắt buộc đăng ký
    const fee = getEntryFee(gameName, m);
    if (meta.requireJoinForScore && fee > 0) {
      const memberSnap = await db.ref(`gameMembers/${gameName}/${m}/${uid}`).get();
      if (!memberSnap.exists()) {
        return res.status(403).json({ ok: false, error: "Chua dang ky mode BXH" });
      }
    }

    const newScore = Number(score);
    if (!Number.isFinite(newScore)) {
      return res.status(400).json({ ok: false, error: "Score không hợp lệ" });
    }

    const userSnap = await db.ref(`users/${uid}/name`).get();
    const userName = userSnap.val() || "Unknown";

    const scorePath = `${getLeaderboardBasePath(gameName, m)}/${uid}`;
    const scoreRef = db.ref(scorePath);
    const snap = await scoreRef.get();

    const compareOrder = String(order || meta.defaultOrder || "desc").toLowerCase();

    if (!snap.exists()) {
      await scoreRef.set({
        bestscore: newScore,
        updatedAt: Date.now(),
        name: userName,
      });
      return res.json({ ok: true, newRecord: true, firstTime: true });
    }

    const current = snap.val() || {};
    const prev = Number(current.bestscore);
    const bestscore = Number.isFinite(prev)
      ? prev
      : (compareOrder === "asc" ? Infinity : 0);

    const isNewRecord = compareOrder === "asc"
      ? newScore < bestscore
      : newScore > bestscore;

    if (isNewRecord) {
      await scoreRef.update({
        bestscore: newScore,
        updatedAt: Date.now(),
        name: userName,
      });
      return res.json({ ok: true, newRecord: true });
    }

    return res.json({ ok: true, newRecord: false });
  } catch (e) {
    console.error("SUBMIT SCORE ERROR:", e);
    return res.status(500).json({ ok: false, error: "Lỗi lưu điểm" });
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

  // 1) CLEAN LINKS
  const usersSnap = await db.ref("users").get();
  const users = usersSnap.val() || {};
  for (const uid in users) {
    const links = users[uid].links || {};
    for (const linkId in links) {
      const link = links[linkId] || {};
      const count = Number(link.count || 0);
      const date = typeof link.date === "string" ? link.date : today;

      if (link.date !== today) {
        updates[`users/${uid}/links/${linkId}/count`] = 0;
        updates[`users/${uid}/links/${linkId}/date`] = today;
      } else if (!Number.isFinite(count) || count < 0) {
        updates[`users/${uid}/links/${linkId}/count`] = 0;
      } else if (date !== link.date) {
        updates[`users/${uid}/links/${linkId}/date`] = date;
      }
    }
  }

  // 2) CLEAN EARN TOKENS (sessions)
  const sessionsSnap = await db.ref("sessions").get();
  const sessions = sessionsSnap.val() || {};
  for (const tokenId in sessions) {
    const s = sessions[tokenId] || {};
    const usedTooOld = s.used && s.usedAt && (now - s.usedAt > 2 * 60 * 60 * 1000);
    const expiredDelete = s.deleteAt && s.deleteAt < now;
    const malformed = !s.uid || !s.linkId || !s.expiresAt;
    if (expiredDelete || usedTooOld || malformed) {
      updates[`sessions/${tokenId}`] = null;
    }
  }

  // 3) CLEAN LOGIN SESSIONS (userSessions)
  const userSessionsSnap = await db.ref("userSessions").get();
  const userSessions = userSessionsSnap.val() || {};
  for (const st in userSessions) {
    const s = userSessions[st] || {};
    if (!s.uid || !s.expiresAt || s.expiresAt < now) {
      updates[`userSessions/${st}`] = null;
    }
  }

  // 4) CLEAN ORDER INDEX ORPHANS
  const ordersSnap = await db.ref("orders").get();
  const orders = ordersSnap.val() || {};

  const byUserSnap = await db.ref("ordersByUser").get();
  const byUser = byUserSnap.val() || {};
  for (const uid in byUser) {
    for (const orderId in (byUser[uid] || {})) {
      if (!orders[orderId]) updates[`ordersByUser/${uid}/${orderId}`] = null;
    }
  }

  const byStatusSnap = await db.ref("ordersByStatus").get();
  const byStatus = byStatusSnap.val() || {};
  for (const status in byStatus) {
    for (const orderId in (byStatus[status] || {})) {
      if (!orders[orderId]) updates[`ordersByStatus/${status}/${orderId}`] = null;
    }
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
  console.log("Clean finished at", new Date().toISOString(), "updates:", Object.keys(updates).length);
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
