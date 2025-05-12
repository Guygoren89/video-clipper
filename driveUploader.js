const fs = require('fs');
const { google } = require('googleapis');
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

async function uploadToDrive(filePath, fileName, matchId, startTime, endTime, segmentStartTimeInGame) {
  console.log('🚀 Uploading to Drive with metadata:', {
    fileName,
    matchId,
    segmentStartTimeInGame
  });

  const fileMetadata = {
    name: fileName,
    parents: ['1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'], // 📁 Full_clips folder ID
    description: `match_id: ${matchId}, segment_start_time_in_game: ${segmentStartTimeInGame}`,
    properties: {
      match_id: matchId,
      segment_start_time_in_game: segmentStartTimeInGame.toString()
    }
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(filePath)
  };

  const driveResponse = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name, webViewLink, webContentLink'
  });

  console.log('✅ Uploaded to Drive:', driveResponse.data);

  return {
    external_id: driveResponse.data.id,
    name: fileName,
    match_id: matchId,
    segment_start_time_in_game: segmentStartTimeInGame,
    view_url: driveResponse.data.webViewLink,
    download_url: driveResponse.data.webContentLink
  };
}

module.exports = { uploadToDrive };
