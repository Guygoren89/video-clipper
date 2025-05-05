const express = require('express');
const router = express.Router();
const { cutClip } = require('./clipCutter');

router.post('/generate-clips', async (req, res) => {
  console.log('📥 קיבלנו בקשה ל- /generate-clips');

  const { file_id, start_time, duration, match_id, action_type } = req.body;

  if (!file_id || typeof start_time !== 'number' || typeof duration !== 'number') {
    return res.status(400).json({ error: 'חסרים פרמטרים חובה (file_id, start_time, duration)' });
  }

  try {
    const result = await cutClip({
      fileId: file_id,
      startTimeInSec: start_time,
      durationInSec: duration,
      matchId: match_id || 'test-match',
      actionType: action_type || 'manual',
    });

    console.log('✅ קליפ נחתך והועלה בהצלחה');
    res.json(result);
  } catch (err) {
    console.error('❌ שגיאה בתהליך generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
