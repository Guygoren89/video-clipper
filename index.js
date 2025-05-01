const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadToDrive } = require('./driveUploader');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log("📅 התחיל תהליך /upload-segment");

  if (!req.file) {
    console.error("❌ לא התקבל קובץ");
    return res.status(400).json({ success: false, error: 'לא התקבל קובץ' });
  }

  console.log("📦 קובץ שהתקבל:", {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    buffer_length: req.file.buffer.length
  });

  const debugPath = `/tmp/debug_${Date.now()}.webm`;
  fs.writeFileSync(debugPath, req.file.buffer);
  console.log(`🧪 עותק לבדיקה נשמר ב: ${debugPath}`);

  try {
    const { match_id = 'test_upload', start_time = '00:00:00', duration = '00:00:12' } = req.body;
    const segmentId = uuidv4();

    const inputPath = `/tmp/input_${segmentId}.webm`;
    const outputPath = `/tmp/segment_${segmentId}.webm`;

    fs.writeFileSync(inputPath, req.file.buffer);
    console.log(`✅ הקובץ נשמר. מתחיל חיתוך עם FFmpeg...`);

    // 🟢 חיתוך מהיר ללא המרה
    const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
    console.log("🎞️ FFmpeg command:", ffmpegCmd);

    exec(ffmpegCmd, async (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg נכשל:", error.message);
        console.error("🧾 stderr:", stderr);
        return res.status(500).json({ success: false, error: 'FFmpeg נכשל' });
      }

      if (!fs.existsSync(outputPath)) {
        console.error("❌ קובץ הפלט לא נמצא");
        return res.status(500).json({ success: false, error: 'קובץ הפלט חסר' });
      }

      console.log("📦 FFmpeg הסתיים. הקובץ מוכן:", outputPath);

      try {
        console.log("🚀 מעלה ל-Google Drive...");
        const driveRes = await uploadToDrive({
          filePath: outputPath,
          metadata: {
            clip_id: segmentId,
            match_id,
            created_date: new Date().toISOString(),
            duration,
            player_id: "manual",
            player_name: "Test Upload",
            action_type: "manual_clip",
          }
        });

        console.log("✅ הועלה בהצלחה:", driveRes.view_url);
        return res.status(200).json({ success: true, clip: driveRes });
      } catch (uploadError) {
        console.error("❌ כשל בהעלאה ל-Drive:", uploadError.message);
        return res.status(500).json({ success: false, error: 'כשל בהעלאה ל-Drive' });
      }
    });
  } catch (err) {
    console.error("🔥 שגיאה כללית:", err.message);
    return res.status(500).json({ success: false, error: 'שגיאה בשרת' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
