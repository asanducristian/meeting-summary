require("dotenv").config();

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const PDFDocument = require("pdfkit");
const {
  transcribeAudio,
  createMeetingMinutes,
  createMeetingTitle,
  translateMinutesToEnglish,
} = require("./openaiMinutes");

const app = express();

app.use(express.json({ limit: "1mb" }));

const token = process.env.TELEGRAM_BOT_TOKEN;
const recordingsDir = process.env.RECORDINGS_DIR || "recordings";
const outputsDir = process.env.OUTPUTS_DIR || "outputs";
const chunkMinutes = Number(process.env.CHUNK_MINUTES) || 10;

const telegramApiBase = "https://api.telegram.org";

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }

        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }

        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(resolve);
        });
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => {
          reject(err);
        });
      });
  });
}

function safeBaseName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function downloadTelegramFile(file, options = {}) {
  const { defaultExt = "", label = "file" } = options;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; skipping download.");
    return null;
  }

  const fileId = file.file_id;
  const fileUrl = `${telegramApiBase}/bot${token}/getFile?file_id=${encodeURIComponent(
    fileId
  )}`;
  const fileResponse = await httpsGetJson(fileUrl);

  if (!fileResponse?.ok || !fileResponse?.result?.file_path) {
    console.warn("Failed to resolve Telegram file path.");
    return null;
  }

  const filePath = fileResponse.result.file_path;
  const ext = path.extname(filePath) || defaultExt || "";
  const safeId = file.file_unique_id || fileId;

  await fsp.mkdir(recordingsDir, { recursive: true });

  let filename;
  if (file.file_name) {
    const base = safeBaseName(path.basename(file.file_name));
    filename = `${Date.now()}-${base}`;
    if (!path.extname(filename) && ext) {
      filename += ext;
    }
  } else {
    filename = `${Date.now()}-${safeId}${ext}`;
  }
  const destPath = path.join(recordingsDir, filename);
  const downloadUrl = `${telegramApiBase}/file/bot${token}/${filePath}`;

  await downloadToFile(downloadUrl, destPath);
  console.log("Saved file to:", destPath);
  return destPath;
}

async function createMinutesPdf(title, minutes, outputPath) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);
    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(minutes, { align: "left" });
    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        const message = stderr ? stderr.toString() : error.message;
        reject(new Error(message));
        return;
      }
      resolve(stdout?.toString() || "");
    });
  });
}

async function splitAudio(filePath, chunkSeconds) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tg-audio-"));
  const outputPattern = path.join(tmpDir, "chunk-%03d.wav");

  await execFileAsync("ffmpeg", [
    "-i",
    filePath,
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    "-reset_timestamps",
    "1",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPattern,
  ]);

  const files = (await fsp.readdir(tmpDir))
    .filter((name) => name.startsWith("chunk-") && name.endsWith(".wav"))
    .sort()
    .map((name) => path.join(tmpDir, name));

  return { dir: tmpDir, files };
}

async function transcribeWithChunks(filePath) {
  const chunkSeconds = Math.max(1, chunkMinutes) * 60;
  const { dir, files } = await splitAudio(filePath, chunkSeconds);

  try {
    let transcript = "";
    for (const chunkPath of files) {
      const chunkText = await transcribeAudio(chunkPath, { language: "ro" });
      if (chunkText) {
        transcript += (transcript ? "\n\n" : "") + chunkText;
      }
    }
    return transcript;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function sendTelegramDocument(chatId, filePath, filename, mimeType) {
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; skipping send.");
    return;
  }

  const buffer = await fsp.readFile(filePath);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(`${telegramApiBase}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`sendDocument failed: ${res.status} ${errorText}`);
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; skipping send.");
    return;
  }

  const res = await fetch(`${telegramApiBase}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`sendMessage failed: ${res.status} ${errorText}`);
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("Cleanup failed:", filePath, err.message);
    }
  }
}

function toAsciiSafe(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKD")                 // split accents
    .replace(/[\u0300-\u036f]/g, "")   // remove diacritic marks
    .replace(/[“”„”]/g, '"')           // normalize quotes
    .replace(/[’‘]/g, "'")             // normalize apostrophes
    .replace(/[–—]/g, "-")             // normalize dashes
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "") // drop all non-ASCII except tabs/newlines
    .replace(/[ \t]+\n/g, "\n")        // trim trailing spaces
    .replace(/\n{3,}/g, "\n\n")        // collapse excessive blank lines
    .trim();
}

async function processAudioFile(filePath, chatId) {
  let transcriptPath;
  let minutesPath;
  try {
    const transcript = await transcribeWithChunks(filePath);
    const transcriptText = transcript.trim();
    if (!transcriptText) {
      await sendTelegramMessage(
        chatId,
        "I couldn't detect any speech in that audio. Please try again with clearer audio."
      );
      return;
    }
    // console.log("transcriptText: ", transcriptText)
    const meetingTitle = await createMeetingTitle(transcript);
    // console.log('meetingtitle: ', meetingTitle);
    const romaianMeetingMinutes = await createMeetingMinutes(transcript);
    const meetingMinutes= translateMinutesToEnglish(romaianMeetingMinutes)

    // console.log("meetingMinutes: ", meetingMinutes)

    const safeSlug = meetingTitle?.slug || `meeting-${Date.now()}`;
    transcriptPath = path.join(outputsDir, `${safeSlug}-transcript.txt`);
    minutesPath = path.join(outputsDir, `${safeSlug}-minutes.pdf`);

    await fsp.mkdir(outputsDir, { recursive: true });
    await fsp.writeFile(transcriptPath, transcript, "utf8");
    await createMinutesPdf(meetingTitle?.title || "Minuta ședinței", meetingMinutes, minutesPath);

    await sendTelegramDocument(chatId, transcriptPath, path.basename(transcriptPath), "text/plain");
    await sendTelegramDocument(chatId, minutesPath, path.basename(minutesPath), "application/pdf");
  } finally {
    await safeUnlink(filePath);
    if (transcriptPath) {
      await safeUnlink(transcriptPath);
    }
    if (minutesPath) {
      await safeUnlink(minutesPath);
    }
  }
}

app.get("/", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/webhook", (req, res) => {
  const update = req.body;

  console.log("Webhook update:");
  console.log(JSON.stringify(update, null, 2));

  const messageText = update?.message?.text;
  if (messageText) {
    console.log("Message text:", messageText);
  }

  const voice = update?.message?.voice;
  if (voice) {
    downloadTelegramFile(voice, { defaultExt: ".ogg", label: "voice" })
      .then((filePath) => {
        if (!filePath) return;
        return processAudioFile(filePath, update?.message?.chat?.id);
      })
      .catch((err) => {
        console.error("Voice processing failed:", err.message);
      });
  }

  const audio = update?.message?.audio;
  if (audio) {
    downloadTelegramFile(audio, { defaultExt: ".mp3", label: "audio" })
      .then((filePath) => {
        if (!filePath) return;
        return processAudioFile(filePath, update?.message?.chat?.id);
      })
      .catch((err) => {
        console.error("Audio processing failed:", err.message);
      });
  }

  const document = update?.message?.document;
  if (document?.mime_type?.startsWith("audio/")) {
    downloadTelegramFile(document, {
      defaultExt: path.extname(document.file_name || "") || ".bin",
      label: "audio-document",
    })
      .then((filePath) => {
        if (!filePath) return;
        return processAudioFile(filePath, update?.message?.chat?.id);
      })
      .catch((err) => {
        console.error("Audio document processing failed:", err.message);
      });
  }

  res.sendStatus(200);
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Telegram webhook server listening on port ${port}`);
});
