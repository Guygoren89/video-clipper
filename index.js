const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ dest: '/tmp' });

const { uploadSegmentToDrive } = require('./driveUploader');
const { cutClip } = require('./segmentsManager');
const { autoGenerateClips } = require('./autoGenerateClips');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Video Clipper API is running');
});

// העלאת מקטע וידאו
app.post('/upload-segment', upload.single('video'), async (req, res) => {
  try {
    const { filename, match_id, start_time, end_time } = req.body;
    const videoFile = req.file;

    if (!videoFile || !filename || !match_id || start_time == null || end_time == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await uploadSegmentToDrive(videoFile, filename, match_id, start_time, end_time);
    res.json(result);
  } catch (err) {
    console.error('upload-segment error:', err);
    res.status(500).json({ error: 'Failed to upload segment' });
  }
});

// חיתוך קליפ בודד
app.post('/generate-clips', async (req, res) => {
  try {
    const { file_id, start_time_in_segment, duration, match_id, action_type } = req.body;

    if (!file_id || start_time_in_segment == null || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await cutClip(file_id, start_time_in_segment, duration, match_id, action_type);
    res.json(result);
  } catch (err) {
    console.error('generate-clips error:', err);
    res.status(500).json({ error: 'Failed to generate clip' });
  }
});

// חיתוך קליפים מרובים
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, clip_timestamps, match_id } = req.body;

    if (!file_id || !Array.isArray(clip_timestamps)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const results = await autoGenerateClips(file_id, clip_timestamps, match_id);
    res.json(results);
  } catch (err) {
    console.error('auto-generate-clips error:', err);
    res.status(500).json({ error: 'Failed to auto generate clips' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
