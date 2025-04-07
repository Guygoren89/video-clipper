// driveUploader.js
const fs = require('fs');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

async function uploadToDrive(filePath, fileName, folderId) {
  console.log(`📤 Starting upload: ${fileName} to folder ${folderId}`);

  try {
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: 'video/mp4',
      body: fs.createReadStream(filePath),
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, webContentLink',
    });

    console.log(`✅ File uploaded to Drive: ${file.data.id}`);
    return file.data;
  } catch (error) {
    console.error(`❌ Failed to upload ${fileName}:`, error.message);
    throw error;
  }
}

module.exports = uploadToDrive;
