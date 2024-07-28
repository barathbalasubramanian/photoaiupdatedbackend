const { google } = require('googleapis');
const fs = require('fs');
const express = require('express');
const cors = require("cors");
const path = require('path');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const pipeline = promisify(require('stream').pipeline);
require('dotenv').config();
const multer = require("multer");
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: "uploads/" });

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function getOauthCredentials(username) {
    console.log(username)
    const { data, error } = await supabase
        .from('Studio-Admin')
        .select('CLIENT_ID, CLIENT_SECRET, REDIRECT_URI,REFRESH_TOKEN')
        .eq('UserID', username)
    if (error) {
        console.error('Error fetching data:', error);
        return null;
    }
    return data;
}

async function initializeOAuth(username) {
    const credentials = await getOauthCredentials(username);
    console.log(credentials)
    if (credentials) {
        const oauth2Client = new google.auth.OAuth2(
            credentials[0]['CLIENT_ID'],
            credentials[0]['CLIENT_SECRET'],
            credentials[0]['REDIRECT_URI']
        );
        oauth2Client.setCredentials({ refresh_token: credentials[0]['REFRESH_TOKEN'] });
        const drive = google.drive({
            version: 'v3',
            auth: oauth2Client,
        });
        console.log("OAuth Completed ..")
        // let folderName = "barath"
        // const response = await drive.files.list({
        //     q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
        //     fields: 'files(id, name)',
        //     spaces: 'drive',
        // });
        // const folders = response.data.files;
        // console.log(folders)
        // console.log(drive)
        return drive;
    } else {
        throw new Error('No credentials found for the specified user.');
    }
}

// Middleware to initialize OAuth and set drive in request
async function initializeOAuthMiddleware(req, res, next) {
    const { UserID } = req.body;
    console.log(UserID)
    try {
        const drive = await initializeOAuth(UserID);
        req.drive = drive;
        next();
    } catch (error) {
        res.status(500).send(error.message);
    }
}





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
        console.log(`Folder ID: ${folderId}`);
        const files = req.files;
        console.log(`Number of files: ${files.length}`);
        const batchSize = 10;
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


app.post("/selected", searchfile);
async function searchfile(req, res) {
    const { selectedFiles, UserID } = req.body;
    console.log(selectedFiles, "SELECTEDFILES ..");
    if (!selectedFiles || selectedFiles.length === 0) {
        return res.status(400).send('No files selected');
    }
    const drive = await initializeOAuth(UserID)
    const files = [];
    try {
        for (let file of selectedFiles) {
            console.log(file.split("/")[0])
            const folderID = await getOrCreateFolder(drive, file.split("/")[0]);
            console.log(folderID)
            const response = await drive.files.list({
                q: `'${folderID}' in parents and name='${file.split("/")[1]}'`,
                fields: 'files(id, name)',
                spaces: 'drive',
            });
            files.push(...response.data.files);
            console.log(files)
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
        const downloadLink = `${req.protocol}://${req.get('host')}/download/${zipFileName}`;
        return res.status(200).json({ message: 'Bulk download complete', link: downloadLink });
    } catch (error) {
        console.error("Error searching files:", error.message);
        return res.status(500).send('Error searching files');
    }
}



// Download SingleFile
app.post("/downloadfile", downloadfilefun);
const getDownloadLinkFromName = async (drive, fileName, folderId) => {
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and name='${fileName}' and trashed=false`,
        fields: "files(id, name, webContentLink)",
      });
      const files = res.data.files;
      if (files.length === 0) {
        throw new Error("No files found");
      }
      return files[0].webContentLink;
    } catch (error) {
      console.error("Error fetching download link:", error);
      throw error;
    }
};
async function downloadfilefun (req,res) {
    const { filename, folderName, UserID } = req.body
    console.log(filename,folderName,UserID)
    const drive = await initializeOAuth(UserID)
    try {
          const folderId = await getOrCreateFolder(drive,folderName)
          const downloadLink = await getDownloadLinkFromName(drive, filename, folderId);
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
        const drive = req.drive
        const filesResponse = await drive.files.list({
            q: `'${folderID}' in parents`,
            fields: 'files(id, name)',
        });
        const files = filesResponse.data.files;
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
            fs.unlinkSync(tempFilePath);  // Remove the temporary file after adding to zip
        }

        zip.writeZip(zipPath);
        console.log('Archive has been finalized.');
        const downloadLink = `${req.protocol}://${req.get('host')}/download/${zipFileName}`;
        console.log(downloadLink)
        return res.status(200).json({ message: 'Bulk download complete', downloadLink });
        
    } catch (error) {
        console.error("Error in bulk download:", error.message);
        res.status(500).send('Error in bulk download');
    }
}
async function getFolderId(req, res, next) {
    console.log(req.body)
    const { folderName,UserID } = req.body;
    console.log(folderName,UserID)
    const drive = await initializeOAuth(UserID)
    try {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });
        const folders = response.data.files;
        console.log("Hii",folders)
        if (folders.length) {
            console.log(`Folder ID for "${folderName}": ${folders[0].id}`);
            req.folderId = folders[0].id;
            console.log(folders[0].id)
            req.drive = drive
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
    console.log(folderName,UserID)
    const drive = await initializeOAuth(UserID);
    console.log(drive)
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
        res.status(200).send('Folder creation success');
    } catch (err) {
        console.error('Error creating folder:', err.message);
        res.status(500).send('Error creating folder');
    }
}



app.listen(8000, () => {
    console.log('Server is running on port 8000');
});
