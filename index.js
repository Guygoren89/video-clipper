const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { cutClipFromDriveFile } = require('./segmentsManager');
const { autoGenerateClips } = require('./autoGenerateClips');
const { uploadToDrive } = require('./uploadToDrive');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

app.post('/upload-segment', upload.single('video'), async (req, res) => {
  try {
    const { originalname, path: localPath } = req.file;
    const { match_id, segment_start_time_in_game } = req.body;

    console.log(`📥 Upload received: ${originalname}`);
    console.log(`📄 Local path: ${localPath}`);
    console.log(`🎮 Match ID: ${match_id}, Segment start: ${segment_start_time_in_game}s`);

    const name = originalname || `segment_${uuidv4()}.webm`;
    const driveFile = await uploadToDrive(localPath, name, '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'); // Full_clips

    console.log(`✅ Uploaded to Drive: ${driveFile.fileId}`);

    res.status(200).json({
      success: true,
      fileId: driveFile.fileId,
      match_id,
      segment_start_time_in_game,
    });

    fs.unlink(localPath, () => {});
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions, segments } = req.body;
  console.log(`✂️ Auto clip request received: ${JSON.stringify({ match_id, actionsCount: actions.length, segmentsCount: segments.length })}`);

  res.status(200).json({ success: true, message: 'Clip generation started in background' });

  try {
    for (const action of actions) {
      const segment = segments.find(s => {
        return (
          action.timestamp_in_game >= s.segment_start_time_in_game &&
          action.timestamp_in_game < s.segment_start_time_in_game + 20
        );
      });

      if (!segment) {
        console.warn(`⚠️ No segment found for action at ${action.timestamp_in_game}s`);
        continue;
      }

      const startTimeInSegment = Math.max(0, action.timestamp_in_game - segment.segment_start_time_in_game - 2);
      const clip = await cutClipFromDriveFile({
        fileId: segment.file_id,
        startTimeInSec: startTimeInSegment,
        durationInSec: 8,
        matchId: match_id,
        actionType: action.action_type,
        playerName: action.player_name,
        assistPlayerName: action.assist_player_name,
        teamColor: action.team_color,
      });

      console.log(`🎬 Clip created: ${clip.name}`);
    }
  } catch (err) {
    console.error('✂️ Error generating clips:', err);
  }
});

app.get('/clips', async (req, res) => {
  // נקרא ע"י דף המדיה/סטטיסטיקות
});

app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
