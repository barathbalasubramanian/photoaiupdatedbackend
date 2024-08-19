const { google } = require('googleapis');
const fs = require('fs');
const express = require('express');
const cors = require("cors");
const path = require('path');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const AWS = require('aws-sdk');
const pipeline = promisify(require('stream').pipeline);
const multer = require("multer");
const { createClient } = require('@supabase/supabase-js');
const { S3Client,PutObjectCommand } = require('@aws-sdk/client-s3');
const sendMail = require('./main');

require('dotenv').config();
const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(cors());

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let credentials_;

// Initialize S3
const s3Client = new S3Client({
    region: process.env.NEXT_PUBLIC_AWS_BUCKET_REGION,
    credentials: {
      accessKeyId: process.env.NEXT_PUBLIC_AWS_ACCESS_KEY,
      secretAccessKey: process.env.NEXT_PUBLIC_AWS_SECRET_KEY
    }
});

async function getOauthCredentials(username) {
    const { data, error } = await supabase
        .from('Studio-Admin')
        .select('CLIENT_ID, CLIENT_SECRET, REDIRECT_URI,REFRESH_TOKEN')
        .eq('UserID', username)
    if (error) {
        console.error('Error fetching data:', error);
        return null;
    }   
    credentials_ = data
    return data;
}
async function initializeOAuth(username) {
    const credentials = await getOauthCredentials(username);
    if (credentials) {
        const oauth2Client = new google.auth.OAuth2(
            credentials[0]['CLIENT_ID'],
            credentials[0]['CLIENT_SECRET'],
            credentials[0]['REDIRECT_URI'],
        );
        oauth2Client.setCredentials({ refresh_token: credentials[0]['REFRESH_TOKEN'] });
        const drive = google.drive({
            version: 'v3',
            auth: oauth2Client,
        });
        console.log("OAuth Completed ..")
        return drive;
    } else {
        throw new Error('No credentials found for the specified user.');
    }
}
// Middleware to initialize OAuth and set drive in request
async function initializeOAuthMiddleware(req, res, next) {
    const { UserID } = req.body;
    try {
        const drive = await initializeOAuth(UserID);
        req.drive = drive;
        next();
    } catch (error) {
        res.status(500).send(error.message);
    }
}


// Common Downloading 
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'test', filename);

    res.download(filePath, (err) => {
        if (err) {
            console.error('Error downloading file:', err);
            res.status(500).send('Error downloading file');
        } else {
            console.log('File downloaded successfully');
        }
    });
});


// Get DriveQuota   
const BYTES_IN_MB = 1048576; // 1024 * 1024
const BYTES_IN_GB = 1073741824; // 1024 * 1024 * 1024
function bytesToMB(bytes) {return bytes / BYTES_IN_MB;}
function bytesToGB(bytes) {return bytes / BYTES_IN_GB;}
async function getRemainingDriveSpace(UserID) {
    const drive = await initializeOAuth(UserID)
    try {
        // Fetch the storage quota information
        const response = await drive.about.get({ fields: 'storageQuota' });
        const { storageQuota } = response.data;
        const { limit, usage } = storageQuota;

        // Calculate remaining space
        const remainingSpace = limit - usage;

        // Convert to MB and GB
        const totalSpaceMB = bytesToMB(limit);
        const usedSpaceMB = bytesToMB(usage);
        const remainingSpaceMB = bytesToMB(remainingSpace);
        const totalSpaceGB = bytesToGB(limit);
        const usedSpaceGB = bytesToGB(usage);
        const remainingSpaceGB = bytesToGB(remainingSpace);

        console.log(`Total space: ${totalSpaceMB.toFixed(2)} MB (${totalSpaceGB.toFixed(2)} GB)`);
        console.log(`Used space: ${usedSpaceMB.toFixed(2)} MB (${usedSpaceGB.toFixed(2)} GB)`);
        console.log(`Remaining space: ${remainingSpaceMB.toFixed(2)} MB (${remainingSpaceGB.toFixed(2)} GB)`);
        return {
            Space:usedSpaceGB.toFixed(2),
            Full:totalSpaceGB.toFixed(2)
        }
    } catch (error) {
        console.error('Error fetching drive space:', error.message);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
    }
}
app.post('/getquota', async (req, res) => {
    const { UserID } = req.body
    console.log(UserID)
    const {Space,Full} = await getRemainingDriveSpace(UserID)
    console.log(Space,Full)
    return res.status(200).json({
        "space": Space,
        "full": Full,
        "message": "Successfully Retrieved",
    })
});


// POST Methods ..
// UploadImages
async function getOrCreateFolder(drive, folderName) {
    try {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });
        const folders = response.data.files;
        if (folders.length > 0) {
            return folders[0].id;
        } else {
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };
            const folder = await drive.files.create({
                requestBody: folderMetadata,
                fields: 'id',
            });
            return folder.data.id;
        }
    } catch (error) {
        console.error('Error getting or creating folder:', error);
        throw error;
    }
}
async function processBatch(drive, files, folderId) {
    const uploadPromises = files.map(async (file) => {
        const fileMetadata = {
            name: file.originalname,
            parents: [folderId], // Specify the parent folder ID
        };
        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path),
        };

        try {
            const response = await drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: "id",
            });
            fs.unlinkSync(file.path);
            return response.data;
        } catch (error) {
            console.error("Error uploading file:", error);
            throw error;
        }
    });

    return await Promise.all(uploadPromises);
}
app.post("/upload", upload.array("files"), initializeOAuthMiddleware, async (req, res) => {
    const { folderName } = req.body;
    const drive = req.drive;
    console.log(`Folder name: ${folderName}`);

    try {
        const folderId = await getOrCreateFolder(drive, folderName || 'defaultFolder');
        const files = req.files;
        const batchSize = 30;
        let results = [];
        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            const batchResults = await processBatch(drive, batch, folderId);
            results = results.concat(batchResults);
            res.write(JSON.stringify(batchResults));
        }
        res.end();
    } catch (error) {
        res.status(500).send(error.message);
    }
});


// Selected Files Download
app.post("/selected", searchfile);
async function searchfile(req, res) {
    const { selectedFiles, UserID } = req.body;
    if (!selectedFiles || selectedFiles.length === 0) {
        return res.status(400).send('No files selected');
    }
    const drive = await initializeOAuth(UserID)
    const files = [];
    try {
        for (let file of selectedFiles) {
            const folderID = await getOrCreateFolder(drive, file.split("/")[0]);
            console.log(folderID)
            const response = await drive.files.list({
                q: `'${folderID}' in parents and name='${file.split("/")[1]}'`,
                fields: 'files(id, name)',
                spaces: 'drive',
            });
            files.push(...response.data.files);
        }

        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = `./test/${zipFileName}`;
        const zip = new AdmZip();
        for (const file of files) {
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(__dirname, 'test', file.name);
            const tempFile = fs.createWriteStream(tempFilePath);
            await pipeline(fileStream.data, tempFile);

            zip.addLocalFile(tempFilePath);
            fs.unlinkSync(tempFilePath);
        }
        zip.writeZip(zipPath);
        console.log('Archive has been finalized.');
        const downloadLink = `https://${req.get('host')}/download/${zipFileName}`;
        return res.status(200).json({ message: 'Bulk download complete', link: downloadLink });
    } catch (error) {
        console.error("Error searching files:", error.message);
        return res.status(500).send('Error searching files');
    }
}


// Download SingleFile
app.post("/downloadfile", downloadfilefun);
async function getFileIdByName(drive,fileName,folderId) {
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and name='${fileName}'`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
      const files = res.data.files;
      if (files.length === 0) {
        console.log(`No files found with name: ${fileName}`);
        return null;
      }
      return files[0].id;
    } catch (error) {
      console.error('Error fetching file ID:', error);
      return null;
    }
}
const getDownloadLinkFromName = async (drive, fileName, folderId) => {
    console.log(fileName)
    const fileId = await getFileIdByName(drive,fileName,folderId);
    try {
        await drive.permissions.create({
            fileId: fileId,
            requestBody: {
              role: 'reader',
              type: 'anyone',
            },
          });
          const file = await drive.files.get({
            fileId: fileId,
            fields: 'webViewLink, webContentLink',
          });
      
          const webViewLink = file.data.webViewLink;
          const webContentLink = file.data.webContentLink;
      
          console.log(`File is accessible via: ${webViewLink}`);
          console.log(`Direct download link: ${webContentLink}`);
          return webContentLink;

        } catch (error) {
        console.error("Error fetching download link:", error);
        throw error;
        }
};
async function downloadfilefun (req,res) {
    const { filename, folderName, UserID } = req.body
    const drive = await initializeOAuth(UserID)
    try {
          const folderId = await getOrCreateFolder(drive,folderName)
          const downloadLink = await getDownloadLinkFromName(drive, filename, folderId);
          console.log(downloadLink)
          return res.status(200).json({ message: 'download complete', link: downloadLink });
    } catch (error) {
        console.error("Error searching files:", error.message);
        res.status(500).send('Error searching files');
    }
}


// Download As Zip

app.post("/downloadall", getFolderId, bulkdownload);
async function bulkdownload(req, res) {
    try {
        const folderID = req.folderId;
        const drive = req.drive;
        const filesResponse = await drive.files.list({
            q: `'${folderID}' in parents`,
            fields: 'files(id, name)',
        });
        const files = filesResponse.data.files;
        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = path.join(__dirname, 'foldertest', zipFileName);
        const zip = new AdmZip();

        for (const file of files) {
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(__dirname, 'foldertest', file.name);
            const tempFile = fs.createWriteStream(tempFilePath);
            await pipeline(fileStream.data, tempFile);

            zip.addLocalFile(tempFilePath);
            fs.unlinkSync(tempFilePath);
        }

        zip.writeZip(zipPath);
        console.log('Archive has been finalized.');

        const currentTime = new Date();
        currentTime.setDate(currentTime.getDate() + 2)

        const fileContent = fs.readFileSync(zipPath);
        const uploadCommand = new PutObjectCommand({
            Bucket: process.env.NEXT_PUBLIC_AWS_BUCKET_NAME,
            Key: `zipping/${zipFileName}`,
            Body: fileContent,
            ACL: "public-read",
            Tagging: `expireDate=${currentTime.toISOString()}`,
        });
        const respo = await s3Client.send(uploadCommand);
        if (respo.$metadata.httpStatusCode == 200) {
            fs.unlinkSync(zipPath);
            console.log(`File uploaded successfully.`);
            let link = `https://selife-bucket.s3.ap-south-1.amazonaws.com/zipping/${zipFileName}`
            sendMail(link,credentials_)
            return res.status(200).json({
                message: 'Bulk download complete and uploaded to S3',
                downloadLink: `https://selife-bucket.s3.ap-south-1.amazonaws.com/zipping/${zipFileName}`
            });
        }

    } catch (error) {
        console.error("Error in bulk download:", error.message);
        res.status(500).send('Error in bulk download');
    }
}
async function getFolderId(req, res, next) {
    const { folderName, UserID } = req.body;
    const drive = await initializeOAuth(UserID);
    try {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });
        const folders = response.data.files;
        if (folders.length) {
            console.log(`Folder ID for "${folderName}": ${folders[0].id}`);
            req.folderId = folders[0].id;
            req.drive = drive;
            next();
        } else {
            console.log(`No folder found with the name "${folderName}".`);
            return res.status(404).send('Folder not found');
        }
    } catch (error) {
        console.error("Error finding folder:", error.message);
        return res.status(500).send('Error finding folder');
    }
}


// Create Folder 
app.post("/createFolder", createFolder);
async function createFolder(req, res) {
    const { folderName,UserID } = req.body;
    const drive = await initializeOAuth(UserID);
    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
    };
    try {
        const file = await drive.files.create({
            requestBody: fileMetadata,
            fields: 'id',
        });
        console.log('Folder Id:', file.data.id);
        return res.status(200).send('Folder creation success');
    } catch (err) {
        console.error('Error creating folder:', err.message);
        return res.status(500).send('Error creating folder');
    }
}


const downloadDir_ = path.join(__dirname, 'foldertest');
if (!fs.existsSync(downloadDir_)) {
    fs.mkdirSync(downloadDir_);
}
const downloadDir = path.join(__dirname, 'test');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
}
app.listen(8080, () => {
    console.log('Server is running on port 8080');
});
