const { downloadFileFromDrive } = require('./driveUploader');
const { exec } = require('child_process');
const { google } = require('googleapis');

// קיים כבר
const drive = google.drive({ version: 'v3', auth });

// ✅ API חדש: חיבור מקטעים
app.post('/merge-segments', async (req, res) => {
  try {
    const { match_id } = req.body;
    if (!match_id) {
      return res.status(400).json({ success: false, error: 'Missing match_id' });
    }

    console.log(`🧩 Starting merge for match_id: ${match_id}`);

    // 1. שליפת הקבצים המתאימים
    const response = await drive.files.list({
      q: `'1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C' in parents and trashed = false and name contains '${match_id}'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime asc',
    });

    const files = response.data.files;
    if (!files.length) {
      return res.status(404).json({ success: false, error: 'No segments found' });
    }

    console.log(`📂 Found ${files.length} segments`);

    // 2. הורדה לשרת
    const inputPaths = [];
    for (const file of files) {
      const filePath = `/tmp/${file.name}`;
      await downloadFileFromDrive(file.id, filePath);
      inputPaths.push(filePath);
    }

    // 3. הכנת קובץ טקסט ל־ffmpeg
    const listPath = '/tmp/segments.txt';
    fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join('\n'));

    // 4. איחוד מקטעים
    const mergedPath = `/tmp/merged_${uuidv4()}.mp4`;
    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i ${listPath} -c copy -y ${mergedPath}`;
    console.log(`🔧 Running FFmpeg merge: ${ffmpegCmd}`);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => {
        if (error) {
          console.error('❌ FFmpeg merge failed:', error.message);
          return reject(error);
        }
        resolve();
      });
    });

    // 5. העלאה לדרייב
    const driveRes = await uploadToDrive({
      filePath: mergedPath,
      metadata: {
        clip_id: uuidv4(),
        match_id,
        player_id: 'merged_game',
        player_name: 'משחק מחובר',
        action_type: 'merged_video',
        created_date: new Date().toISOString(),
        duration: '', // לא חובה כאן
      },
    });

    res.status(200).json({ success: true, merged_video: driveRes });

  } catch (error) {
    console.error('🔥 Error in /merge-segments:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});
