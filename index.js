const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { uploadSegmentToDrive } = require('./driveUploader');
const { autoGenerateClips } = require('./autoGenerateClips');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// תצורת multer לשמירת קבצים זמניים
const upload = multer({ dest: 'uploads/' });

// 🔵 נתיב בריאות
app.get('/', (req, res) => {
  res.send('Video Clipper Server is running');
});

// 🔴 נתיב העלאת מקטע
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id, start_time, end_time } = req.body;
    const file = req.file;

    if (!file || !match_id || !start_time || !end_time) {
      console.error('❌ Missing required fields:', { match_id, start_time, end_time, file });
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    console.log('📤 Uploading segment:', {
      name: file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      match_id,
      start_time,
      end_time,
    });

    const clip = await uploadSegmentToDrive(file, file.originalname, match_id, start_time, end_time);

    console.log('✅ Upload complete:', clip);

    res.status(200).json({ success: true, clip: { google_file_id: clip.file_id } });
  } catch (error) {
    console.error('❌ Error in /upload-segment:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🟢 נתיב חיתוך לפי פעולות
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, clip_timestamps } = req.body;

    if (!file_id || !match_id || !clip_timestamps || !Array.isArray(clip_timestamps)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid parameters' });
    }

    console.log('✂️ Clipping from file:', file_id);
    console.log('📋 Actions:', clip_timestamps);

    const results = await autoGenerateClips(file_id, match_id, clip_timestamps);

    res.status(200).json(results);
  } catch (error) {
    console.error('❌ Error in /auto-generate-clips:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
