const { S3Client, ListObjectsV2Command, GetObjectTaggingCommand } = require("@aws-sdk/client-s3");
require('dotenv').config();

const s3Client = new S3Client({
  region: process.env.NEXT_PUBLIC_AWS_BUCKET_REGION,
  credentials: {
    accessKeyId: process.env.NEXT_PUBLIC_AWS_ACCESS_KEY,
    secretAccessKey: process.env.NEXT_PUBLIC_AWS_SECRET_KEY,
  },
});

const run = async () => {
  const bucketName = process.env.NEXT_PUBLIC_AWS_BUCKET_NAME;
  const prefix = "zipping/";

  const params = {
    Bucket: bucketName,
    Prefix: prefix,
  };

  try {
    const data = await s3Client.send(new ListObjectsV2Command(params));
    const now = new Date();

    for (const item of data.Contents) {
      const objectKey = item.Key;

      // Retrieve the object's tags
      const taggingParams = {
        Bucket: bucketName,
        Key: objectKey,
      };

      const taggingData = await s3Client.send(new GetObjectTaggingCommand(taggingParams));
      let expirationDate;

      const expireTag = taggingData.TagSet.find(tag => tag.Key === 'expireDate');
      if (expireTag) {
        expirationDate = new Date(expireTag.Value);
        console.log(`Object: ${objectKey}`);
        console.log(`Current Time: ${now}`);
        console.log(`Expiration Date: ${expirationDate}`);
      } else {
        console.log(`Object: ${objectKey} has no expireDate tag.`);
      }

      if (expirationDate && now > expirationDate) {
        console.log(`Expired.`);
        // Uncomment the lines below to delete the expired object
        const deleteParams = {
          Bucket: bucketName,
          Key: objectKey,
        };
        await s3Client.send(new DeleteObjectCommand(deleteParams));
        console.log(`Deleted expired object: ${objectKey}`);
      }
    }
  } catch (err) {
    console.error("Error processing objects:", err);
  }
};

run();






// const { S3Client, PutBucketLifecycleConfigurationCommand } = require("@aws-sdk/client-s3");

// const s3Client = new S3Client({ region: "ap-south-1" });

// const params = {
//   Bucket: "selife-bucket",
//   LifecycleConfiguration: {
//     Rules: [
//       {
//         ID: "AutoDeleteBasedOnTag",
//         Filter: {
//           Tag: {
//             Key: "expireDate",
//             Value: "2024-08-01T07:46:09Z" // Example value to match
//           }
//         },
//         Status: "Enabled",
//         Expiration: {
//           Days: 1 // Will delete objects tagged with "expireDate=..." after 1 day from creation
//         }
//       }
//     ]
//   }
// };

// const run = async () => {
//   try {
//     await s3Client.send(new PutBucketLifecycleConfigurationCommand(params));
//     console.log("Lifecycle rule created successfully.");
//   } catch (err) {
//     console.error("Error creating lifecycle rule", err);
//   }
// };

// run();
