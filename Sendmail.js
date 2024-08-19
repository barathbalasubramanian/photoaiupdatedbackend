// sendMail.js
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
require('dotenv').config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = '1//04BKC0OkZoAX7CgYIARAAGAQSNwF-L9IrPC6J8yYsGLkPMkvqbvKKGzmg4UBw3umuJ2MogTU7zvQYMFeemW2pQUVr1rAhvm6pEic';

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const sendMail = async (link,credentials_) => {
  
  
  console.log(credentials_)
  console.log({
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  })

  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN  });
  
  try {
    const accessToken = (await oAuth2Client.getAccessToken()).token;
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: 'photoaitool.anthill@gmail.com',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    const mailOptions = {
      from: 'viratbarath218@gmail.com',
      to: 'barathkumar.b2411@gmail.com',
      subject: 'New Form',
      text: `Link: ${link}`,
    };

    await transport.sendMail(mailOptions);
    console.log('Email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
};

module.exports = sendMail;
