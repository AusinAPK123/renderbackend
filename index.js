const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const crypto = require("crypto"); // Dùng để tạo session token ngẫu nhiên

const app = express();
app.use(express.json());
app.use(cors());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://luxta-a2418-default-rtdb.firebaseio.com"
});

const db = admin.database();

// --- MIDDLEWARE CHẶN PHÁP SƯ (Tùy chọn) ---
const checkBanStatus = async (uid) => {
    const snap = await db.ref(`users/${uid}/coins`).get();
    return (snap.val() || 0) < 0;
};

// --- LOGIN & SESSION ---
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const firebaseAuth = await loginWithFirebase(email, password);
    const uid = firebaseAuth.uid;

    const userRef = db.ref(`users/${uid}`);
    const snap = await userRef.get();
    const userData = snap.val() || {};

    // 1. Kiểm tra máy chém
    if (userData.coins < 0) {
      return res.status(403).json({ ok: false, error: "Tài khoản bị phong ấn do hack!" });
    }

    // 2. Tạo Session Token bí mật
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

// --- CỘNG COIN QUA TOKEN (CÓ BẪY THỜI GIAN) ---
app.post("/use-token", async (req, res) => {
  try {
    const { token, uid } = req.body; // App gửi kèm uid để xác minh
    if (!token) return res.status(400).json({ error: "Missing token" });

    const tokenRef = db.ref(`sessions/${token}`);
    const tokenSnap = await tokenRef.get();
    const tokenData = tokenSnap.val();

    if (!tokenData) return res.status(404).json({ error: "Token không tồn tại" });
    if (tokenData.used) return res.status(400).json({ error: "Token đã sử dụng" });
    if (tokenData.uid !== uid) return res.status(403).json({ error: "Sai chủ sở hữu" });

    const now = Date.now();
    
    // BẪY CHÍ MẠNG: Nếu nộp token quá sớm (dưới 15 giây kể từ lúc get-token)
    // Người thường không thể vượt link nhanh thế được, chỉ có bot gọi API.
    const MIN_WORK_TIME = 15000; 
    if (now - tokenData.startAt < MIN_WORK_TIME) {
        await db.ref(`users/${uid}/coins`).set(-999999); // TRẢM!
        return res.status(400).json({ error: "Pháp sư phát hiện! Acc đã bị ban." });
    }

    const COIN_ADD = 30;
    const coinRef = db.ref(`users/${uid}/coins`);
    await coinRef.transaction(current => (current || 0) + COIN_ADD);

    // Update count link trong ngày
    const linkRef = db.ref(`users/${uid}/links/${tokenData.link}`);
    const today = new Date().toISOString().slice(0,10);
    await linkRef.transaction(current => {
      if (!current || current.date !== today) return { date: today, count: 1 };
      return { ...current, count: (current.count||0) + 1 };
    });

    await tokenRef.update({ used: true, deleteAt: now + 6 * 3600000 });
    res.json({ ok: true, added: COIN_ADD });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// --- KIỂM TRA LUẬT & TRẠNG THÁI ---
app.get("/check-rules", async (req, res) => {
  try {
    const { uid, token } = req.query;
    if (!uid) return res.status(400).json({ ok: false, error: "Missing uid" });

    const userRef = db.ref(`users/${uid}`);
    const snap = await userRef.get();
    const userData = snap.val() || {};

    // Check session token
    if (token && userData.session && userData.session.token !== token) {
        return res.status(401).json({ ok: false, error: "Hết hạn phiên" });
    }

    res.json({ 
        ok: true, 
        rulesAccepted: !!userData.rulesAccepted,
        isBanned: (userData.coins < 0),
        coins: userData.coins || 0
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// --- LẤY TOKEN (GÀI THỜI GIAN BẮT ĐẦU) ---
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
      startAt: now, // Lưu mốc thời gian bắt đầu lấy
      deleteAt: now + 6 * 3600000
    });

    res.json({ ok: true, token, countToday });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// --- CÁC ROUTE CÒN LẠI (GIỮ NGUYÊN) ---
app.post("/spend-coin", async (req, res) => { /* Code của bạn */ });
app.post("/submit-score", async (req, res) => { /* Code của bạn */ });
app.post("/add-xp", async (req, res) => { /* Code của bạn */ });
app.post("/accept-rules", async (req, res) => { /* Code của bạn */ });
app.get("/notifications", async (req, res) => { /* Code của bạn */ });
app.post("/cleanup-tokens", async (req, res) => { /* Code của bạn */ });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("System Securing on port", PORT));
