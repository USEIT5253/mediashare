
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const META_DIR = path.join(ROOT, "data", "links");

const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const TTL_MS = 5 * 60 * 60 * 1000;

for (const dir of [UPLOAD_DIR, META_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.disable("x-powered-by");

app.use(express.urlencoded({
  extended: false,
  limit: "10kb"
}));

app.use(session({
  name: "mediashare.sid",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TTL_MS
  }
}));

// File storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, _file, cb) => {
    cb(null, crypto.randomBytes(24).toString("hex"));
  }
});

// Updated upload filter: accepts image/* and video/* MIME types.
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();

    const allowed =
      mime.startsWith("image/") ||
      mime.startsWith("video/");

    cb(
      allowed ? null : new Error("Please select an image or video file."),
      allowed
    );
  }
});

const metaPath = id => path.join(META_DIR, `${id}.json`);

function readMeta(id) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(id)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
  } catch {
    return null;
  }
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

// Delete expired files
function cleanExpired() {
  for (const name of fs.readdirSync(META_DIR)) {
    if (!name.endsWith(".json")) continue;

    const p = path.join(META_DIR, name);

    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));

      if (m.expiresAt <= Date.now()) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, m.storedName));
        } catch {}

        try {
          fs.unlinkSync(p);
        } catch {}
      }
    } catch {}
  }
}

cleanExpired();
setInterval(cleanExpired, 60_000).unref();

app.use(express.static(path.join(ROOT, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Upload route
app.post("/upload", (req, res, next) => {
  upload.single("media")(req, res, err => {
    if (err) {
      console.error("Upload error:", err);

      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "The file exceeds the 5 GB limit."
          : err.message || "Upload failed.";

      return res.status(400).send(errorPage(message));
    }

    next();
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).send(
      errorPage("Choose a photo or video first.")
    );
  }

  const password = String(req.body.password || "");

  if (password.length < 4 || password.length > 128) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).send(
      errorPage("Password must be 4–128 characters.")
    );
  }

  const requestedName = String(req.body.linkName || "")
    .trim()
    .toLowerCase();

  const slug = requestedName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  if (slug.length < 3) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).send(
      errorPage("Choose a link name with at least 3 letters or numbers.")
    );
  }

  if (fs.existsSync(metaPath(slug))) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).send(
      errorPage("That link name is already taken. Please choose another one.")
    );
  }

  const salt = crypto.randomBytes(16).toString("hex");

  const meta = {
    id: slug,
    originalName: path.basename(req.file.originalname).slice(0, 240),
    storedName: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    salt,
    hash: passwordHash(password, salt),
    expiresAt: Date.now() + TTL_MS
  };

  try {
    fs.writeFileSync(
      metaPath(slug),
      JSON.stringify(meta),
      { mode: 0o600, flag: "wx" }
    );
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error("Metadata save error:", err);

    return res.status(500).send(
      errorPage("Could not save the upload information.")
    );
  }

  res.redirect(`/share/${slug}`);
});

// Share page
app.get("/share/:id", (req, res) => {
  const m = readMeta(req.params.id);

  if (!m || m.expiresAt <= Date.now()) {
    return res.status(404).send(
      errorPage("This link has expired or does not exist.")
    );
  }

  if (req.session.authorized && req.session.authorized[m.id]) {
    return res.send(mediaPage(m));
  }

  res.send(passwordPage(m.id));
});

// Password verification
app.post("/share/:id/unlock", (req, res) => {
  const m = readMeta(req.params.id);

  if (!m || m.expiresAt <= Date.now()) {
    return res.status(404).send(
      errorPage("This link has expired or does not exist.")
    );
  }

  const attempt = passwordHash(
    String(req.body.password || ""),
    m.salt
  );

  if (!safeEqual(attempt, m.hash)) {
    return res.status(401).send(
      passwordPage(m.id, "Incorrect password. Try again.")
    );
  }

  req.session.authorized = req.session.authorized || {};
  req.session.authorized[m.id] = true;

  res.redirect(`/share/${m.id}`);
});

// Authorization middleware
function authorize(req, res, next) {
  const m = readMeta(req.params.id);

  if (!m || m.expiresAt <= Date.now()) {
    return res.status(404).send(
      errorPage("This link has expired or does not exist.")
    );
  }

  if (!req.session.authorized || !req.session.authorized[m.id]) {
    return res.redirect(`/share/${m.id}`);
  }

  req.shareMeta = m;
  next();
}

// Media preview with browser range support
app.get("/share/:id/view", authorize, (req, res) => {
  const m = req.shareMeta;
  const filePath = path.join(UPLOAD_DIR, m.storedName);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return res.status(404).send("File not found.");
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", m.mimeType);
    res.setHeader("Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(m.originalName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");

    if (!range) {
      res.setHeader("Content-Length", fileSize);
      return fs.createReadStream(filePath).pipe(res);
    }

    const parts = range.replace(/bytes=/, "").split("-");
    const start = Number(parts[0]);
    const end = parts[1]
      ? Math.min(Number(parts[1]), fileSize - 1)
      : fileSize - 1;

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= fileSize ||
      end < start
    ) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", end - start + 1);

    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
});

// Download route
app.get("/share/:id/download", authorize, (req, res) => {
  const m = req.shareMeta;
  const filePath = path.join(UPLOAD_DIR, m.storedName);

  res.download(filePath, m.originalName);
});

// HTML helpers
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · MediaShare</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="shell">
${body}
<footer>MediaShare · Private, temporary media sharing</footer>
</main>
</body>
</html>`;
}

function errorPage(msg) {
  return page("Notice", `
<section class="panel narrow">
<a class="brand" href="/">MediaShare<span>.</span></a>
<h1>Something went wrong</h1>
<p class="muted">${esc(msg)}</p>
<a class="button" href="/">Back to upload</a>
</section>`);
}

function passwordPage(id, error = "") {
  return page("Password required", `
<section class="panel narrow">
<a class="brand" href="/">MediaShare<span>.</span></a>
<div class="lock">🔒</div>
<h1>This media is protected</h1>
<p class="muted">Enter the password from the sender to view or download this file.</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/share/${id}/unlock">
<label for="password">Password</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button class="button full" type="submit">Unlock media</button>
</form>
</section>`);
}

function fmt(n) {
  if (n < 1024) return `${n} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(2)} ${units[i]}`;
}

function mediaPage(m) {
  const preview = m.mimeType.startsWith("image/")
    ? `<img class="preview" src="/share/${m.id}/view" alt="${esc(m.originalName)}">`
    : `<video class="preview" src="/share/${m.id}/view" controls playsinline preload="metadata"></video>`;

  const mins = Math.ceil(
    Math.max(0, m.expiresAt - Date.now()) / 60000
  );

  return page("Shared media", `
<section class="panel">
<a class="brand" href="/">MediaShare<span>.</span></a>
<div class="success">✓ Password accepted</div>
<h1>Your media is ready</h1>
<p class="filename">${esc(m.originalName)}</p>
${preview}
<div class="details">
<span>${fmt(m.size)}</span>
<span>Expires in about ${mins} min</span>
</div>
<a class="button full" href="/share/${m.id}/download">Download file</a>
<p class="small muted">This file and link are automatically deleted 5 hours after upload.</p>
</section>`);
}

// Error handler
app.use((err, _req, res, _next) => {
  console.error("Server error:", err);

  if (!res.headersSent) {
    res.status(500).send(
      errorPage("The server encountered an error.")
    );
  }
});

// Start server
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`MediaShare running at http://localhost:${PORT}`);
  console.log("Upload limit: 5 GiB.");
  console.log("Keep this Command Prompt window open.");
});

// Allow long uploads
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
httpServer.headersTimeout = 60_000;
