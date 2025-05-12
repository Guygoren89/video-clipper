const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { uploadToDrive } = require('./driveUploader');
const { formatTime, cutClipFromDriveFile } = require('./segmentsManager');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

// ✅ העלאת מקטעים
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id, start_time, end_time } = req.body;
    const file = req.file;

    console.log('📤 Uploading segment:', {
      name: file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      match_id,
      start_time,
      end_time
    });

    const uploaded = await uploadToDrive(file.path, file.originalname, match_id, start_time, end_time);

    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ חיתוך אוטומטי על בסיס file_id ו־start_time
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, actions } = req.body;

    console.log('✂️ Auto clip request received:', {
      file_id,
      match_id,
      actions
    });

    const clips = [];

    for (const action of actions) {
      const { start_time, action_type } = action;

      const clip = await cutClipFromDriveFile({
        fileId: file_id,
        matchId: match_id,
        startTimeInSec: formatTime(start_time),
        durationInSec: 8,
        actionType: action_type
      });

      clips.push(clip);
    }

    res.json({ success: true, clips });
  } catch (err) {
    console.error('[CLIP ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => {
  console.log('📡 Server listening on port 3000');
});
