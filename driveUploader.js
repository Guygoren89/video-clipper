// driveUploader.js
const fs = require('fs');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function uploadToDrive(filePath, fileName, folderId) {
  try {
    console.log(📤 Starting upload: ${fileName} to folder ${folderId});
    
    const driveService = google.drive({ version: 'v3', auth: await auth.getClient() });

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: 'video/mp4',
      body: fs.createReadStream(filePath),
    };

    const response = await driveService.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, webContentLink',
    });

    console.log(✅ File uploaded: ${response.data.id});
    return response.data;
  } catch (err) {
    console.error(❌ Failed to upload file ${fileName}:, err.message);
    throw err;
  }
}

module.exports = uploadToDrive;
