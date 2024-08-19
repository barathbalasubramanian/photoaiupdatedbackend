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
const sharp = require('sharp');
require('dotenv').config();
const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(cors());
const { Readable } = require('stream');

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

async function compressImage(inputBuffer) {
    try {
        const outputBuffer = await sharp(inputBuffer)
            .rotate() // This ensures the image is correctly oriented based on EXIF data
            .toFormat('jpeg') // Specify format if needed
            .toBuffer();

        return outputBuffer;
    } catch (error) {
        console.error('Error compressing image:', error);
        throw error;
    }
}

async function processBatch(drive, files, folderId) {
    const uploadPromises = files.map(async (file) => {
        try {
            // Get the original file size
            const originalFileSize = fs.statSync(file.path).size;

            // Compress the file buffer
            const inputBuffer = fs.readFileSync(file.path);
            const compressedBuffer = await compressImage(inputBuffer);

            // Convert buffer to stream
            const compressedStream = Readable.from(compressedBuffer);

            // Prepare the metadata with original file size
            const fileMetadata = {
                name: file.originalname,
                parents: [folderId], // Specify the parent folder ID
                description: `${originalFileSize}`, // Add original file size as metadata
            };

            const media = {
                mimeType: 'image/jpeg', // Adjust the mimeType according to your needs
                body: compressedStream, // Use the stream here
            };

            const response = await drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id',
            });

            fs.unlinkSync(file.path); // Remove the original uncompressed file
            return response.data;
        } catch (error) {
            console.error('Error uploading file:', error);
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


app.post("/downloadall", getFolderId, bulkdownload);
async function decompressImage(inputPath, outputPath) {
    console.log(inputPath,outputPath)
    try {
        if (inputPath === outputPath) {
            throw new Error('Input and output paths must be different.');
        }
        await sharp(inputPath)
            .toFile(outputPath);
        console.log(`Image decompressed and saved to ${outputPath}`);
        return
    } catch (error) {
        console.error('Error decompressing image:', error);
        return
    }
}

async function matchFileSize(decompressedPath, originalSize) {
    try {
        const decompressedStats = await fs.promises.stat(decompressedPath);
        console.log(decompressedStats.size, originalSize);
        if (decompressedStats.size < originalSize) {
            const paddingSize = originalSize - decompressedStats.size;
            const paddingBuffer = Buffer.alloc(paddingSize, 0);
            await fs.promises.appendFile(decompressedPath, paddingBuffer);
            console.log(`Padded decompressed image to match original file size.`);
            return
        } else {
            console.log(`No padding needed. Sizes match.`);
            return
        }
    } catch (error) {
        console.error('Error matching file sizes:', error);
        return
    }
}

async function bulkdownload(req, res) {
    try {
        const folderID = req.folderId;
        const drive = req.drive;
        const filesResponse = await drive.files.list({
            q: `'${folderID}' in parents`,
            fields: 'files(id, name, description)',
        });
        const files = filesResponse.data.files;
        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = path.join(__dirname, 'foldertest', zipFileName);
        const zip = new AdmZip();

        const folderPath = path.join(__dirname, 'foldertestfiles');
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath);
        }
        console.log(files)
        for (const file of files) {
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(folderPath, file.name);
            const tempFile = fs.createWriteStream(tempFilePath);

            await new Promise((resolve, reject) => {
                fileStream.data
                    .pipe(tempFile)
                    .on('finish', resolve)
                    .on('error', reject);
            });

            tempFile.close();

            if (fs.existsSync(tempFilePath)) {
                console.log('File successfully downloaded:', tempFilePath);
            } else {
                console.error('File not found after download:', tempFilePath);
                continue; // Skip this file and continue with the next
            }

            const originalSize = parseInt(file.description, 10);
            const decompressedFilePath = path.join(folderPath, `${file.name}_decompressed.jpg`);

            await decompressImage(tempFilePath, decompressedFilePath);
            await matchFileSize(decompressedFilePath, originalSize);

            zip.addLocalFile(decompressedFilePath);
        }   

        zip.writeZip(zipPath);
        console.log('Archive has been finalized.');
        // fs.unlinkSync(folderPath);
        // fs.unlinkSync(zipPath);

        return res.status(200).json({
            message: 'Bulk download complete and ZIP file created.',
            downloadLink: `https://selife-bucket.s3.ap-south-1.amazonaws.com/zipping/${zipFileName}`
        });

    } catch (error) {
        console.error("Error in bulk download:", error.message);
        res.status(500).send('Error in bulk download');
    }
}


app.post("/selected", searchfile);
async function searchfile(req, res) {
    const { selectedFiles, UserID } = req.body;
    if (!selectedFiles || selectedFiles.length === 0) {
        return res.status(400).send('No files selected');
    }

    const drive = await initializeOAuth(UserID);
    const files = [];

    try {
        for (let file of selectedFiles) {
            const folderID = await getOrCreateFolder(drive, file.split("/")[0]);
            const response = await drive.files.list({
                q: `'${folderID}' in parents and name='${file.split("/")[1]}'`,
                fields: 'files(id, name, description)',
                spaces: 'drive',
            });
            files.push(...response.data.files);
        }

        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = path.join(__dirname, 'test', zipFileName);
        const zip = new AdmZip();
        console.log(files);

        const tempoPath = path.join(__dirname, 'temp' + Math.random().toString(36).substring(2, 8) + Math.random().toString(36).substring(2, 8));
        const folderPath = path.join(__dirname, 'temp');

        if (!fs.existsSync(tempoPath)) {
            fs.mkdirSync(tempoPath, { recursive: true });
        }
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        for (const file of files) {
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(tempoPath, file.name);
            const tempFile = fs.createWriteStream(tempFilePath);

            await pipeline(fileStream.data, tempFile);
            tempFile.end(); // Ensure the file stream is closed

            const originalSize = parseInt(file.description, 10);
            const decompressedFilePath = path.join(folderPath, `${file.name}_decompressed.jpg`);

            try {
                await decompressImage(tempFilePath, decompressedFilePath);
                await matchFileSize(decompressedFilePath, originalSize);
                zip.addLocalFile(decompressedFilePath);
            } catch (error) {
                console.error('Error during decompression or padding:', error);
            }
        }

        zip.writeZip(zipPath);
        console.log('Archive has been finalized.');
        const downloadLink = `http://${req.get('host')}/download/${zipFileName}`;
        console.log(downloadLink);

        setTimeout(() => {
            try {
                console.log(`Attempting to delete tempoPath: ${tempoPath}`);
                fs.rmSync(tempoPath, { recursive: true, force: true });
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log('Folders deleted successfully!');
            } catch (err) {
                console.error(`Error deleting folders: ${err}`);
            }
        }, 5000);

        return res.status(200).json({ message: 'Bulk download complete', link: downloadLink });
    } catch (error) {
        console.error("Error searching files:", error.message);
        return res.status(500).send('Error searching files');
    }
}



app.post("/singlefile", async function searchfile(req, res) {
    const { filename, folderName, UserID } = req.body;

    try {
        const drive = await initializeOAuth(UserID);
        const folderID = await getOrCreateFolder(drive, folderName);

        const response = await drive.files.list({
            q: `'${folderID}' in parents and name='${filename}'`,
            fields: 'files(id, name, description)',
            spaces: 'drive',
        });

        if (response.data.files.length === 0) {
            return res.status(404).json({ message: 'File not found' });
        }

        const file = response.data.files[0];
        console.log(file)
        const fileStream = await drive.files.get({
            fileId: file.id,
            alt: 'media',
        }, { responseType: 'stream' });

        const temp = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const tempFilePath = path.join(__dirname, temp , file.name);
        if (!fs.existsSync(temp)) {
            fs.mkdirSync(temp);
        }


        const tempFile = fs.createWriteStream(tempFilePath);
        await pipeline(fileStream.data, tempFile);

        const originalSize = parseInt(file.description, 10);
        if (isNaN(originalSize)) {
            console.warn(`Invalid original size for file ${file.name}`);
            return res.status(500).json({ message: 'Invalid original size in metadata' });
        }

        const folderPath = path.join(__dirname, 'test');
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath);
        }

        const decompressedFilePath = path.join(folderPath, `${file.name}_decompressed.jpg`);

        await decompressImage(tempFilePath, decompressedFilePath);
        await matchFileSize(decompressedFilePath, originalSize);

        console.log('File processing complete.');
        const downloadLink =   `http://${req.get('host')}/download/${file.name}_decompressed.jpg`
        console.log(downloadLink)
        return res.status(200).json({ message: 'File ready for download', link: downloadLink });

    } catch (error) {
        console.error("Error searching files:", error.message);
        return res.status(500).send('Error processing file');
    }
});


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

const downloadDir_ = path.join(__dirname, 'foldertest');
if (!fs.existsSync(downloadDir_)) {
    fs.mkdirSync(downloadDir_);
}
const downloadDir = path.join(__dirname, 'test');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
}

app.listen(8000);