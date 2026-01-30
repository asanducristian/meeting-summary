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
  const { model = "whisper-1", language } = options; // ← no default

  const apiKey = getApiKey();
  const audioBuffer = await fs.readFile(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append("file", new File([audioBuffer], filename));
  form.append("model", model);

  // ONLY include language if explicitly requested
  if (language) {
    form.append("language", language);
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.text ?? "";
}

async function translateMinutesToEnglish(romanianMinutes, options = {}) {
  const { model = "gpt-4o-mini" } = options;
  const apiKey = getApiKey();

  const ro = String(romanianMinutes || "").trim();
  if (!ro) return "";

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
                "You are a translation engine.\n" +
                "Translate the text from Romanian to English.\n" +
                "Rules:\n" +
                "- Preserve the original Markdown structure exactly (headings, lists, numbering).\n" +
                "- Do not add or remove sections.\n" +
                "- Do not summarize or reinterpret; translate faithfully.\n" +
                "- Output plain text only.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: ro }],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Minutes translation failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return extractOutputText(data).trim();
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
                "IMPORTANT:\n" +
                "- Output MUST be ASCII only.\n" +
                "- Write in Romanian BUT WITHOUT diacritics.\n" +
                "- Use '-' not en-dash/em-dash.\n" +
                "- Use only plain quotes: \" \".\n\n" +
                "Generează un titlu scurt și descriptiv pentru ședință în limba română (3–10 cuvinte). " +
                "Returnează DOAR titlul, fără ghilimele, fără text suplimentar.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `Transcript:\n${transcript}` }],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Title generation failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const title = extractOutputText(data).trim() || "Ședință";
  const slug = slugifyTitle(title) || `sedinta-${Date.now()}`;

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
                "IMPORTANT:\n" +
                "- Output MUST be ASCII only.\n" +
                "- Write in Romanian BUT WITHOUT diacritics.\n" +
                "- Use '-' not en-dash/em-dash.\n" +
                "- Use only plain quotes: \" \".\n\n" +

                "Esti un asistent de meeting minutes. Scopul tau este sa extragi CE S-A SPUS, nu sa inventezi.\n" +
                "Daca ceva nu este clar in transcript, marcheaza ca 'neclar' sau 'de confirmat'.\n" +
                "Elimina repetitiile, interjectiile si limbajul informal, dar pastreaza detaliile operationale.\n\n" +

                "Foloseste STRICT aceasta structura:\n" +
                "## Minuta sedintei\n" +
                "### Context\n" +
                "- 1-2 propozitii: despre ce este sedinta.\n" +
                "### Rezumat (3-6 puncte)\n" +
                "- bullets, fiecare cu informatie concreta.\n" +
                "### Flow descris (pas cu pas)\n" +
                "- listeaza pasii operationali exact in ordinea mentionata.\n" +
                "### Decizii\n" +
                "- daca nu exista, scrie: \"Nu s-au consemnat decizii.\"\n" +
                "### Actiuni / Next steps\n" +
                "- lista numerotata. Daca nu exista, scrie: \"Nu s-au consemnat actiuni.\"\n" +
                "### Intrebari deschise\n" +
                "- lista. Daca nu exista, scrie: \"Nu s-au consemnat intrebari.\"\n"
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `Transcript:\n${transcript}` }],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Minutes generation failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return extractOutputText(data).trim();
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
  translateMinutesToEnglish
};
