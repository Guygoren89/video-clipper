const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { uploadToDrive } = require('./driveUploader');
const { formatTime, cutClipFromDriveFile } = require('./segmentsManager');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

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

app.listen(3000, () => {
  console.log('📡 Server listening on port 3000');
});
