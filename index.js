const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const fs = require('fs');
const csv = require('csv-parser');
const db = require('./database');
const path = require('path');

const app = express();
const PORT = 80;
//test
//earn
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'secret-key-project-ai-scheduler',
    resave: false,
    saveUninitialized: true
}));

app.use(express.static('public'));

const checkAuth = (req, res, next) => {
    if (req.session.loggedin) next();
    else res.redirect('/login');
};

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
        if (err) throw err;
        if (row && bcrypt.compareSync(password, row.password)) {
            req.session.loggedin = true;
            req.session.username = username;
            res.redirect('/dashboard');
        } else {
            res.render('login', { error: 'Username หรือ Password ไม่ถูกต้อง' });
        }
    });
});
app.get('/dashboard', checkAuth, (req, res) => {
    res.render('dashboard', { user: req.session.username });
});
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});
app.get('/', (req, res) => res.redirect('/login'));

const readCSV = (fileName) => {
    return new Promise((resolve) => {
        const filePath = path.join(__dirname, fileName);
        const results = [];
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ Warning: ไม่พบไฟล์ ${fileName}`);
            return resolve([]);
        }
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (err) => resolve([]));
    });
};

const extractNames = (dataArray) => {
    return [...new Set(dataArray.map(item => {
        const vals = Object.values(item);
        return vals[1] ? vals[1].trim() : vals[0];
    }))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
};

app.get('/api/init-data', checkAuth, async (req, res) => {
    try {
        const [groups, teachers, rooms] = await Promise.all([
            readCSV('student_group.csv'),
            readCSV('teacher.csv'),
            readCSV('room.csv')
        ]);
        res.json({
            groups: extractNames(groups),
            teachers: extractNames(teachers),
            rooms: extractNames(rooms)
        });
    } catch (error) {
        res.status(500).json({ error: "Init Data Error: " + error.message });
    }
});

app.get('/api/generate', checkAuth, async (req, res) => {
    try {
        console.log("--- เริ่มประมวลผลและอ่านข้อมูล Advisor ---");
        const schedule = await runScheduler();
        res.json(schedule); 
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const runScheduler = async () => {
    let seed = 12345;
    const seededRandom = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };

    const [teachers, rooms, groups, subjects, teach, timeslots, registers] = await Promise.all([
        readCSV('teacher.csv'), readCSV('room.csv'), readCSV('student_group.csv'),
        readCSV('subject.csv'), readCSV('teach.csv'), readCSV('timeslot.csv'), readCSV('register.csv')
    ]);

    const teacherMap = {}; teachers.forEach(r => teacherMap[Object.values(r)[0]] = Object.values(r)[1] || Object.values(r)[0]);
    const roomMap = {}; rooms.forEach(r => roomMap[Object.values(r)[0]] = Object.values(r)[1] || Object.values(r)[0]);
    
    // =========================================================
    // ★ ส่วนอ่านข้อมูล Advisor จาก CSV (ปรับปรุงใหม่) ★
    // =========================================================
    const groupMap = {}; 
    const advisorMap = {}; 

    groups.forEach(row => {
        // แปลง key ทั้งหมดเป็นตัวเล็กเพื่อให้หาง่าย (เช่น Advisor -> advisor)
        const lowerKeys = {};
        Object.keys(row).forEach(k => lowerKeys[k.toLowerCase().trim()] = row[k]);

        const vals = Object.values(row);
        const groupId = vals[0]; // คอลัมน์แรกคือ ID เสมอ
        
        groupMap[groupId] = vals[1] || vals[0]; // คอลัมน์สองคือชื่อกลุ่ม

        // พยายามหาคอลัมน์ที่ชื่อ advisor หรือครูที่ปรึกษา
        let advisorName = lowerKeys['advisor'] || lowerKeys['teacher'] || lowerKeys['ครูที่ปรึกษา'] || lowerKeys['ที่ปรึกษา'];
        
        // ถ้าหาชื่อคอลัมน์ไม่เจอ ให้ลองหยิบคอลัมน์ที่ 3 (index 2) มาใช้
        if (!advisorName && vals.length >= 3) {
            advisorName = vals[2];
        }

        // ถ้ามีข้อมูล ให้ Trim ช่องว่าง, ถ้าไม่มีให้ใส่จุดไข่ปลา
        advisorMap[groupId] = advisorName ? advisorName.trim() : ".......................................";
    });

    const subjectTeachers = {};
    teach.forEach(row => {
        const vals = Object.values(row);
        if(vals.length >= 2) {
            const tId = vals[0];
            const sId = vals[1];
            if (!subjectTeachers[sId]) subjectTeachers[sId] = [];
            subjectTeachers[sId].push(tId);
        }
    });

    const allRoomIds = rooms.length > 0 ? rooms.map(r => Object.values(r)[0]) : ['Room_Unknown'];
    const theoryRooms = rooms.filter(r => r && Object.values(r).some(v => String(v).toLowerCase() === 'theory')).map(r => Object.values(r)[0]);
    const practiceRooms = rooms.filter(r => r && !Object.values(r).some(v => String(v).toLowerCase() === 'theory')).map(r => Object.values(r)[0]);
    const safeTheoryRooms = theoryRooms.length > 0 ? theoryRooms : allRoomIds;
    const safePracticeRooms = practiceRooms.length > 0 ? practiceRooms : allRoomIds;

    let baseSlots = timeslots.filter(t => t && parseInt(t.period) !== 5).map(t => ({
        id: t.timeslot_id, day: t.day, period: parseInt(t.period), start: t.start, end: t.end
    }));

    const busy = { teacher: new Set(), group: new Set(), room: new Set() };
    const setBusy = (type, id, day, period) => busy[type].add(`${id}_${day}_${period}`);
    const isBusy = (type, id, day, period) => busy[type].has(`${id}_${day}_${period}`);
    const output = [];
    const groupDailyHours = {}; 

    const allGroupIds = [...new Set(registers.map(r => {
        const vals = Object.values(r);
        return vals.find(v => v && String(v).trim().startsWith('G'));
    }).filter(Boolean))];

    allGroupIds.forEach(gId => {
        groupDailyHours[gId] = { 'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0 };
        // กิจกรรมองค์การ
        [8, 9].forEach(p => {
            let timeStr = p===8 ? "15:00 - 16:00" : "16:00 - 17:00";
            // ดึง Advisor Map ที่อ่านได้ มาใส่ตรงนี้
            output.push({
                group: groupMap[gId] || gId,
                group_advisor: advisorMap[gId], 
                teacher: "ครูที่ปรึกษา/ส่วนกลาง",
                room: "ลานกิจกรรม",
                subject: "ACT-001",
                subject_name: "กิจกรรมองค์การวิชาชีพ",
                day: "Wed",
                period: p,
                time: timeStr,
                theory: 0, practice: 2
            });
            setBusy('group', gId, 'Wed', p);
            if(groupDailyHours[gId]) groupDailyHours[gId]['Wed']++;
        });
    });

    let tasks = [];
    registers.forEach(reg => {
        try {
            const vals = Object.values(reg);
            const sId = vals.find(v => v && String(v).includes('-')); 
            const gId = vals.find(v => v && String(v).trim().startsWith('G'));
            if (sId && gId) {
                const subject = subjects.find(s => Object.values(s).includes(sId));
                if (subject) {
                    const subVals = Object.values(subject);
                    const th = parseInt(subVals[2]) || 0;
                    const pr = parseInt(subVals[3]) || 0;
                    const sName = subVals[1] || sId;
                    for(let i=0; i<th; i++) tasks.push({type:'Theory', group:gId, subject:sId, subject_name: sName, th_val: th, pr_val: pr});
                    for(let i=0; i<pr; i++) tasks.push({type:'Practice', group:gId, subject:sId, subject_name: sName, th_val: th, pr_val: pr});
                }
            }
        } catch(e) {}
    });

    allGroupIds.forEach(gId => {
        tasks.push({
            type: 'Theory', group: gId,
            subject: 'HOMEROOM', subject_name: 'โฮมรูม (พบครูที่ปรึกษา)',
            th_val: 1, pr_val: 0, force_teacher: 'Advisor'
        });
    });

    tasks.sort(() => seededRandom() - 0.5);

    for (const task of tasks) {
        let assigned = false;
        let potentialTeachers = [];
        if (task.force_teacher === 'Advisor') potentialTeachers = ['T_Advisor'];
        else potentialTeachers = subjectTeachers[task.subject] || [];
        const potentialRooms = task.type === 'Theory' ? safeTheoryRooms : safePracticeRooms;

        const currentLoad = groupDailyHours[task.group];
        const dayPriority = Object.keys(currentLoad).sort((a, b) => currentLoad[a] - currentLoad[b]);
        const dayWeight = {}; dayPriority.forEach((d, index) => dayWeight[d] = index);
        let candidates = [...baseSlots];
        candidates.sort((a, b) => {
            if (dayWeight[a.day] !== dayWeight[b.day]) return dayWeight[a.day] - dayWeight[b.day];
            const pA = a.period <= 8 ? 1 : 2; 
            const pB = b.period <= 8 ? 1 : 2;
            if (pA !== pB) return pA - pB;
            return a.period - b.period; 
        });

        for (const slot of candidates) {
            if (assigned) break;
            if (isBusy('group', task.group, slot.day, slot.period)) continue;

            let selectedTeacher = 'T_Unknown';
            if (task.force_teacher === 'Advisor') {
                selectedTeacher = advisorMap[task.group]; // ใช้ชื่อจริงที่อ่านจาก CSV
            } else if (potentialTeachers.length > 0) {
                const t = potentialTeachers.find(t => !isBusy('teacher', t, slot.day, slot.period));
                if (!t) continue;
                selectedTeacher = t;
            }
            
            let selectedRoom = potentialRooms.find(r => !isBusy('room', r, slot.day, slot.period));
            if (!selectedRoom) continue;

            assigned = true;
            setBusy('group', task.group, slot.day, slot.period);
            if(task.force_teacher !== 'Advisor') {
                setBusy('teacher', selectedTeacher, slot.day, slot.period);
            }
            setBusy('room', selectedRoom, slot.day, slot.period);
            if(groupDailyHours[task.group]) groupDailyHours[task.group][slot.day]++;

            output.push({
                group: groupMap[task.group] || task.group,
                group_advisor: advisorMap[task.group], // ส่งชื่อที่ปรึกษา
                teacher: teacherMap[selectedTeacher] || selectedTeacher,
                room: roomMap[selectedRoom] || selectedRoom,
                subject: task.subject, 
                subject_name: task.subject_name,
                day: slot.day, 
                period: slot.period, 
                time: `${slot.start} - ${slot.end}`,
                theory: task.th_val,
                practice: task.pr_val
            });
        }
    }
    return output;
};

app.listen(PORT, () => {
    console.log(`🚀 Server พร้อมทำงานแล้วที่ http://localhost:${PORT}`);
});