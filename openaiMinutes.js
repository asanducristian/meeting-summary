const fs = require("fs/promises");
const path = require("path");

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function getApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  return key;
}

function extractOutputText(responseJson) {
  if (responseJson?.output?.length) {
    const first = responseJson.output[0];
    const content = first?.content?.[0];
    if (content?.type === "output_text") {
      return content.text;
    }
    if (content?.text) {
      return content.text;
    }
  }
  return responseJson?.output_text || "";
}

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);
}

async function transcribeAudio(filePath, options = {}) {
  const { model = "whisper-1", language = "en" } = options;
  const apiKey = getApiKey();

  const audioBuffer = await fs.readFile(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  if (language) {
    form.append("language", language);
  }

  const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Transcription failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  return data.text || "";
}

async function createMeetingTitle(transcript, options = {}) {
  const { model = "gpt-4o-mini" } = options;
  const apiKey = getApiKey();

  const res = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Generate a short, descriptive meeting title in English (3-8 words). " +
                "Return only the title, no quotes or extra text.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Transcript:\n${transcript}`,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Title generation failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  const title = extractOutputText(data).trim() || "Meeting";
  const slug = slugifyTitle(title) || `meeting-${Date.now()}`;

  return { title, slug };
}

async function createMeetingMinutes(transcript, options = {}) {
  const { model = "gpt-4o-mini" } = options;
  const apiKey = getApiKey();

  const res = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a meeting minutes assistant. Produce crisp, accurate minutes " +
                "in English. Use these sections in order: Summary, Decisions, Action Items, " +
                "Questions. Keep Summary to 3-5 bullets. Decisions must be explicit; if none, " +
                "say 'None'. Action Items must be a numbered list with owners if mentioned; " +
                "if none, say 'None'. Questions list open issues only.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Transcript:\n${transcript}`,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Minutes generation failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  return extractOutputText(data);
}

async function transcribeAndSummarize(filePath, options = {}) {
  const { transcription = {}, minutes = {}, title = {} } = options;
  const transcript = await transcribeAudio(filePath, transcription);
  const meetingTitle = await createMeetingTitle(transcript, title);
  const meetingMinutes = await createMeetingMinutes(transcript, minutes);

  return { transcript, minutes: meetingMinutes, title: meetingTitle };
}

module.exports = {
  transcribeAudio,
  createMeetingTitle,
  createMeetingMinutes,
  transcribeAndSummarize,
};
