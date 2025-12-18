const express = require("express");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

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

    // sau khi cộng coin
const linkRef = db.ref(`users/${uid}/links/${tokenData.link}`);
const today = new Date().toISOString().slice(0,10);

await linkRef.transaction(current => {
  if (!current || current.date !== today) {
    return { date: today, count: 1 };
  } else {
    return { ...current, count: (current.count||0) + 1 };
  }
});

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

app.post("/add-xp", async (req, res) => {
  try {
    const { uid, xpToAdd = 5 } = req.body; // mặc định mỗi lần +5 XP
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const xpRef = db.ref(`users/${uid}/xp`);
    const lvRef = db.ref(`users/${uid}/level`);

    const [xpSnap, lvSnap] = await Promise.all([xpRef.get(), lvRef.get()]);
    let currentXp = xpSnap.val() || 0;
    let level = lvSnap.val() || 0;

    const levelXP = [100,150,200,250,300,350,400,450,500,550,600,650,700,750,800]; // XP cần lên mỗi level

    if (level < 15) {
      currentXp += xpToAdd;

      // kiểm tra đủ XP để lên cấp
      while (level < 15 && currentXp >= levelXP[level]) {
        currentXp -= levelXP[level];
        level++;
      }

      // nếu level=15, giới hạn XP max
      if (level >= 15) {
        level = 15;
        currentXp = Math.min(currentXp, 6749); // max XP
      }

      await Promise.all([xpRef.set(currentXp), lvRef.set(level)]);
    }

    res.json({ ok: true, xp: currentXp, level });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- tạo token mới cho web1 ---
app.post("/get-token", async (req, res) => {
  try {
    const { uid, linkId } = req.body;
    if (!uid || !linkId) return res.status(400).json({ error: "Missing uid or linkId" });

    const linkRef = db.ref(`users/${uid}/links/${linkId}`);
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Lấy dữ liệu link hôm nay
    const snap = await linkRef.get();
    const linkData = snap.val() || {};
    let countToday = (linkData.date === today) ? (linkData.count || 0) : 0;

    if (countToday >= 2) {
      // vượt quá hạn mức hôm nay -> trả countToday nhưng không tạo token
      return res.json({ ok: false, countToday });
    }

    // tạo token mới
    const token = uuidv4();
    const startAt = now;
    const expireAt = now + 60 * 60 * 1000; // token có hiệu lực 60 giây
    const deleteAt = now + 6 * 60 * 60 * 1000; // xóa sau 6h

    await db.ref(`sessions/${token}`).set({
      token,
      uid,
      link: linkId,
      used: false,
      startAt,
      expireAt,
      deleteAt
    });

    // trả về số lần vượt hôm nay + token mới
    res.json({
      ok: true,
      token,
      countToday
    });

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
