// database.js
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./users.db', (err) => {
    if (err) {
        console.error('❌ เชื่อมต่อ Database ไม่ได้:', err.message);
    } else {
        console.log('✅ เชื่อมต่อ SQLite Database สำเร็จ');
    }
});

// สร้างตาราง users และเพิ่ม admin เริ่มต้น
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    // สร้าง user: admin / pass: 1234 (ถ้ายังไม่มี)
    const stmt = db.prepare("INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)");
    const hash = bcrypt.hashSync("1234", 10);
    stmt.run("admin", hash);
    stmt.finalize();
});

module.exports = db;