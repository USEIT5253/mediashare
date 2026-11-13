MEDIASHARE — WINDOWS SETUP
==========================

FEATURES
- Choose a custom link name, for example /share/birthday-party (must be unique).
- One photo or video per upload, up to 5 GB.
- Each share has its own password.
- Choose your own custom link name (for example: /share/my-family-video). Link names must be unique.
- Browser preview and download after password entry.
- Files and links expire 5 hours after upload.
- Files are stored locally in the uploads folder.
- Responsive layout for phones, tablets and computers.

INSTALL / RUN
1. Extract this ZIP.
2. Open the extracted MediaShare folder in File Explorer.
3. Click the address bar, type cmd, and press Enter.
4. Run: npm install
5. Run: npm start
6. Open: http://localhost:3000

Keep the Command Prompt window open while the site is in use. If you already have an older MediaShare folder, stop its server with Ctrl+C, extract this updated ZIP into a new folder, then run npm install and npm start from the new folder.
Stop the server with Ctrl+C.

IMPORTANT
- The computer and server must remain on for people to use links.
- This only works on your own computer at localhost until you configure safe remote access.
- For people outside your home network, you need a secure HTTPS tunnel or properly configured hosting/network access. Do not expose your computer directly to the internet without security review.
- A 5 GB transfer requires enough free disk space, reliable bandwidth and a connection that permits large uploads. Network/router/browser limits may apply.
- Expiry cleanup runs every minute while the server is running and also runs on startup.
- This is a starter personal project, not hardened production hosting. The default in-memory session store is not suitable for a large public service. Add HTTPS, rate limiting, a persistent session store and security review before public exposure.
- Only upload media you have the right to share.

FILES
uploads\      uploaded media
data\links\   metadata and password hashes

If port 3000 is busy, run:
  set PORT=3001
  npm start
Then visit http://localhost:3001.

LARGE UPLOAD NOTE
The server has no short request timeout for large uploads. A 5 GB file can still take a long time and may fail due to Wi-Fi, ISP/router, browser, antivirus, or available disk space. Test with 100–500 MB before trying the full 5 GB. Keep the browser tab and server running until the upload completes.
