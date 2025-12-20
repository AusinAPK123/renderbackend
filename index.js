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

// --- HELPER LOGIN (GIỮ NGUYÊN) ---
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

    if (userData.coins < 0) return res.status(403).json({ ok: false, error: "Tài khoản bị phong ấn!" });

    const sessionToken = crypto.randomBytes(20).toString('hex');
    await userRef.child("session").set({ token: sessionToken, lastLogin: Date.now() });

    res.json({ ok: true, uid, token: sessionToken, rulesAccepted: !!userData.rulesAccepted, coins: userData.coins || 0 });
  } catch (err) { res.status(401).json({ ok: false, error: "Sai thông tin!" }); }
});

// --- 2. HỆ THỐNG TOKEN & CHỐNG HACK COIN ---
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
    await db.ref(`sessions/${token}`).set({ token, uid, link: linkId, used: false, startAt: now, deleteAt: now + 6 * 3600000 });
    res.json({ ok: true, token, countToday });
  } catch (err) { res.status(500).send("Server error"); }
});

app.post("/use-token", async (req, res) => {
  try {
    const { token, uid } = req.body;
    const tokenRef = db.ref(`sessions/${token}`);
    const snap = await tokenRef.get();
    const data = snap.val();

    if (!data || data.used || data.uid !== uid) return res.status(400).json({ error: "Token invalid" });

    // MÁY CHÉM: Link rút gọn không thể vượt dưới 15s
    if (Date.now() - data.startAt < 15000) {
        await db.ref(`users/${uid}/coins`).set(-999999);
        return res.status(400).json({ error: "Hack detected!" });
    }

    await db.ref(`users/${uid}/coins`).transaction(c => (c || 0) + 30);
    await tokenRef.update({ used: true });
    res.json({ ok: true, added: 30 });
  } catch (err) { res.status(500).send("Server error"); }
});

// --- 3. CÁC HÀM XỬ LÝ GAME (ĐOẠN THIẾU CỦA BẠN) ---

// Tiêu coin để chơi hoặc mua đồ
app.post("/spend-coin", async (req, res) => {
    const { uid, amount } = req.body;
    const userRef = db.ref(`users/${uid}/coins`);
    const snap = await userRef.get();
    if ((snap.val() || 0) < amount) return res.status(400).json({ ok: false, error: "Không đủ xu!" });
    
    await userRef.transaction(c => c - amount);
    res.json({ ok: true });
});

// Lưu điểm cao
app.post("/submit-score", async (req, res) => {
    const { uid, score } = req.body;
    const scoreRef = db.ref(`users/${uid}/highScore`);
    const snap = await scoreRef.get();
    if (score > (snap.val() || 0)) {
        await scoreRef.set(score);
        return res.json({ ok: true, newRecord: true });
    }
    res.json({ ok: true, newRecord: false });
});

// Cộng kinh nghiệm
app.post("/add-xp", async (req, res) => {
    const { uid, xp } = req.body;
    await db.ref(`users/${uid}/xp`).transaction(current => (current || 0) + xp);
    res.json({ ok: true });
});

// Chấp nhận luật chơi
app.post("/accept-rules", async (req, res) => {
    const { uid } = req.body;
    await db.ref(`users/${uid}/rulesAccepted`).set(true);
    res.json({ ok: true });
});

// Lấy thông báo từ admin
app.get("/notifications", async (req, res) => {
    const snap = await db.ref("notifications").get();
    res.json(snap.val() || []);
});

// Dọn dẹp token hết hạn (chạy bằng cron job hoặc tay)
app.post("/cleanup-tokens", async (req, res) => {
    const now = Date.now();
    const snap = await db.ref("sessions").get();
    const tokens = snap.val();
    for (let id in tokens) {
        if (tokens[id].deleteAt < now) await db.ref(`sessions/${id}`).remove();
    }
    res.json({ ok: true });
});

// --- KHỞI ĐỘNG ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("System Securing on port", PORT));
