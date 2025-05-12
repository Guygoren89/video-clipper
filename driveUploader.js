async function uploadToDrive(filePath, fileName, matchId, startTime, endTime, segmentStartTimeInGame) {
  console.log('🚀 Uploading to Drive with metadata:', {
    fileName,
    matchId,
    segmentStartTimeInGame
  });

  const fileMetadata = {
    name: fileName,
    parents: ['1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'], // תיקיית Full_clips
    description: `match_id: ${matchId}, segment_start_time_in_game: ${segmentStartTimeInGame}`
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(filePath)
  };

  const driveResponse = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name'
  });

  // מחזיר את המטאדאטה לשימוש נוסף
  return {
    external_id: driveResponse.data.id,
    name: fileName,
    match_id: matchId,
    segment_start_time_in_game: segmentStartTimeInGame
  };
}

module.exports = { uploadToDrive };
