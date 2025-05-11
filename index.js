const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { uploadSegmentToDrive } = require('./driveUploader');
const { cutClip } = require('./segmentsManager');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// בדיקת חיבור
app.get('/', (req, res) => {
  res.send('Video Clipper API is running');
});

// העלאת מקטע (20 שניות)
app.post('/upload-segment', async (req, res) => {
  try {
    const { base64Video, filename, match_id, start_time, end_time } = req.body;

    if (!base64Video || !filename || !match_id || start_time == null || end_time == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await uploadSegmentToDrive(base64Video, filename, match_id, start_time, end_time);
    res.json(result);
  } catch (err) {
    console.error('upload-segment error:', err);
    res.status(500).json({ error: 'Failed to upload segment' });
  }
});

// חיתוך קליפ קצר מתוך מקטע
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
