const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());

// --- KHỞI TẠO FIREBASE ---
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://luxta-a2418-default-rtdb.firebaseio.com"
});

const db = admin.database();

// --- HELPER LOGIN (QUAN TRỌNG - GIỮ NGUYÊN TỪ FILE GỐC) ---
async function loginWithFirebase(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { uid: data.localId };
}

// --- 1. LOGIN & SESSION ---
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const firebaseAuth = await loginWithFirebase(email, password);
    const uid = firebaseAuth.uid;

    const userRef = db.ref(`users/${uid}`);
    const snap = await userRef.get();
    const userData = snap.val() || {};

    if (userData.coins < 0) {
      return res.status(403).json({ ok: false, error: "Tài khoản bị phong ấn!" });
    }

    const sessionToken = crypto.randomBytes(20).toString('hex');
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
  } catch (err) {
    res.status(401).json({ ok: false, error: "Sai email hoặc mật khẩu!" });
  }
});

// --- 2. HỆ THỐNG TOKEN (CÓ BẪY THỜI GIAN) ---
app.post("/get-token", async (req, res) => {
  try {
    const { uid, linkId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    
    const linkRef = db.ref(`users/${uid}/links/${linkId}`);
    const snap = await linkRef.get();
    const linkData = snap.val() || {};
    let countToday = (linkData.date === today) ? (linkData.count || 0) : 0;

    if (countToday >= 20) return res.json({ ok: false, error: "Hết lượt hôm nay" });

    const token = uuidv4();
    const now = Date.now();

    await db.ref(`sessions/${token}`).set({
      token, uid, link: linkId, used: false,
      startAt: now,
      deleteAt: now + 6 * 3600000
    });

    res.json({ ok: true, token, countToday });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post("/use-token", async (req, res) => {
  try {
    const { token, uid } = req.body;
    const tokenRef = db.ref(`sessions/${token}`);
    const tokenSnap = await tokenRef.get();
    const tokenData = tokenSnap.val();

    if (!tokenData || tokenData.used || tokenData.uid !== uid) {
        return res.status(400).json({ error: "Token không hợp lệ" });
    }

    // BẪY CHÍ MẠNG (15s)
    if (Date.now() - tokenData.startAt < 15000) {
        await db.ref(`users/${uid}/coins`).set(-999999);
        return res.status(400).json({ error: "Pháp sư phát hiện! Acc bị ban." });
    }

    await db.ref(`users/${uid}/coins`).transaction(c => (c || 0) + 30);
    await tokenRef.update({ used: true });
    res.json({ ok: true, added: 30 });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// --- 3. MULTI-GAME LEADERBOARD (NÂNG CẤP THEO Ý BẠN) ---
app.post("/submit-score", async (req, res) => {
    try {
        const { uid, score, gameName } = req.body;
        if(!gameName) return res.status(400).json({ error: "Thiếu tên game!" });

        // Lưu vào mục riêng của game đó: leaderboard/Tetris/uid...
        const scoreRef = db.ref(`leaderboard/${gameName}/${uid}`);
        const snap = await scoreRef.get();
        const current = snap.val() || { score: 0 };

        if (score > current.score) {
            await scoreRef.set({
                score: score,
                updatedAt: Date.now()
            });
            return res.json({ ok: true, newRecord: true });
        }
        res.json({ ok: true, newRecord: false });
    } catch (err) { res.status(500).json({ error: "Lỗi lưu điểm" }); }
});

// --- 4. CÁC ROUTE CÒN LẠI (GIỮ ĐÚNG LOGIC GỐC) ---
app.post("/spend-coin", async (req, res) => {
    const { uid, amount } = req.body;
    const coinRef = db.ref(`users/${uid}/coins`);
    const snap = await coinRef.get();
    if((snap.val() || 0) < amount) return res.status(400).json({ error: "Không đủ coin" });
    await coinRef.transaction(c => c - amount);
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
    res.json({ ok: true, rulesAccepted: !!data.rulesAccepted, coins: data.coins || 0 });
});

// Khởi động
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Hệ thống Luxta đang chạy tại port", PORT));
    
